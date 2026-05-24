const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const chokidar = require('chokidar');
const drivelist = require('drivelist');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure port via environment variable or command line argument (e.g., `node server.js 8080`)
const PORT = process.env.PORT || process.argv[2] || 3000;
const CACHE_FILE = path.join(__dirname, 'usb-cache.json');

app.use(express.static('public'));

let usbStatus = [];
let isTesting = false;

// Load cache from disk
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error loading cache:', e);
    }
    return {};
}

// Save cache to disk
function saveCache(cache) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error('Error saving cache:', e);
    }
}

async function testDriveSpeed(mountPath, device) {
    const testFileSize = 50 * 1024 * 1024; // 50MB
    const tempFile = path.join(mountPath, 'speedtest.tmp');

    let writeSpeed = 0;
    let readSpeed = 0;

    // --- READ TEST via `dd` (Raw Block Device) ---
    // This allows testing read speed even if the drive is mounted as Read-Only.
    // Only use `dd` on Linux because macOS will throw "Permission Denied" without sudo.
    if (process.platform === 'linux') {
        try {
            const command = `dd if=${device}1 of=/dev/null bs=10M count=10 iflag=direct`
            console.log(`Testing read speed on block device ${device} using ${command}...`);
            const { stderr } = await execAsync(command);

            // Output format varies, but usually ends with something like: "..., 1.234 s, 42.5 MB/s"
            const speedMatch = stderr.match(/,\s*([0-9.]+)\s*(MB\/s|GB\/s|kB\/s|B\/s)/i);
            if (speedMatch) {
                let speedVal = parseFloat(speedMatch[1]);
                const unit = speedMatch[2].toUpperCase();
                // Convert everything to MB/s
                if (unit === 'GB/S') speedVal *= 1024;
                if (unit === 'KB/S') speedVal /= 1024;
                if (unit === 'B/S') speedVal /= (1024 * 1024);
                readSpeed = speedVal;
            } else {
                console.log("Could not parse dd output:", stderr);
            }
        } catch (e) {
            console.error(`dd read test failed on ${device}:`, e.message);
            // We will fallback to 0.00 if dd fails
        }
    }

    // --- WRITE & READ TEST via File System ---
    try {
        const buffer = crypto.randomBytes(testFileSize);

        const startWrite = process.hrtime.bigint();
        fs.writeFileSync(tempFile, buffer);
        const endWrite = process.hrtime.bigint();

        const writeTimeSec = Number(endWrite - startWrite) / 1e9;
        writeSpeed = (testFileSize / 1024 / 1024) / writeTimeSec;

        // If we didn't use `dd` (e.g. on macOS), test read speed from the file we just wrote
        if (process.platform !== 'linux') {
            const startRead = process.hrtime.bigint();
            fs.readFileSync(tempFile);
            const endRead = process.hrtime.bigint();

            const readTimeSec = Number(endRead - startRead) / 1e9;
            readSpeed = (testFileSize / 1024 / 1024) / readTimeSec;
        }

    } catch (e) {
        console.error(`Failed to test write speed on ${mountPath}:`, e.message);
    } finally {
        if (fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) { }
        }
    }

    return {
        writeSpeed: writeSpeed.toFixed(2),
        readSpeed: readSpeed.toFixed(2)
    };
}

async function updateUsbStatus(forceTest = false) {
    if (isTesting) return;
    isTesting = true;

    const cache = loadCache();
    let hasChanges = false;

    // Notify clients that testing is in progress
    io.emit('testing', true);

    try {
        const drives = await drivelist.list();
        const externalDrives = drives.filter(d => d.isUSB || d.isRemovable);
        const drivesToTest = externalDrives.filter(d => d.mountpoints && d.mountpoints.length > 0);

        const totalDrives = drivesToTest.length;
        let completedDrives = 0;

        io.emit('testing_progress', { completed: completedDrives, total: totalDrives });

        const newStatus = [];

        for (const drive of drivesToTest) {
            const mountPath = drive.mountpoints[0].path;
            const device = drive.device;
            const label = path.basename(mountPath);
            const capacity = (drive.size / (1024 * 1024 * 1024)).toFixed(2);
            const name = drive.description || 'USB Drive';

            let speeds;

            // Check if we have cached data and we are not forcing a refresh
            if (!forceTest && cache[mountPath]) {
                console.log(`Using cached speed for ${mountPath}`);
                speeds = cache[mountPath].speeds;
            } else {
                console.log(`Testing speed for ${mountPath} (${device})...`);
                speeds = await testDriveSpeed(mountPath, device);
                // Update cache
                cache[mountPath] = {
                    speeds,
                    lastTested: new Date().toISOString()
                };
                hasChanges = true;
            }

            newStatus.push({
                name,
                label,
                mountPath,
                capacity: `${capacity} GB`,
                writeSpeed: speeds.writeSpeed,
                readSpeed: speeds.readSpeed,
                lastUpdated: cache[mountPath].lastTested
            });

            completedDrives++;
            io.emit('testing_progress', { completed: completedDrives, total: totalDrives });
            
            // Broadcast data progressively to clients
            io.emit('usbStatus', newStatus);
        }

        // Clean up cache: remove any cached drives that are no longer connected
        const currentMountPaths = newStatus.map(d => d.mountPath);
        for (const cachedPath of Object.keys(cache)) {
            if (!currentMountPaths.includes(cachedPath)) {
                console.log(`USB unmounted, removing from cache: ${cachedPath}`);
                delete cache[cachedPath];
                hasChanges = true;
            }
        }

        if (hasChanges) {
            saveCache(cache);
        }

        usbStatus = newStatus;
        console.log('USB speed test completed.');

    } catch (e) {
        console.error('Error updating USB status:', e);
    } finally {
        isTesting = false;
        io.emit('testing', false);
    }
}

// Watch for USB mount/unmount
const osType = process.platform;
if (osType === 'darwin') {
    console.log('Setting up real-time USB detection for macOS on /Volumes...');
    let timeout;
    chokidar.watch('/Volumes', {
        depth: 0,
        ignoreInitial: true
    }).on('all', (event, path) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            console.log(`Detected change in volumes: ${event} ${path}`);
            updateUsbStatus(false);
        }, 1000);
    });
} else if (osType === 'linux') {
    console.log('Setting up real-time USB detection for Linux on /media and /mnt...');
    let timeout;
    chokidar.watch(['/media', '/mnt'], {
        depth: 2, // /media/username/USB-NAME
        ignoreInitial: true
    }).on('all', (event, path) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            console.log(`Detected change in mounts: ${event} ${path}`);
            updateUsbStatus(false);
        }, 1000);
    });
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected to socket');
    // Send initial status
    socket.emit('usbStatus', usbStatus);
    socket.emit('testing', isTesting);

    socket.on('requestRefresh', () => {
        console.log('Manual refresh requested by client');
        updateUsbStatus(true); // force test
    });
});

// Initial run
updateUsbStatus(false);

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
