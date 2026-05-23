const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const chokidar = require('chokidar');
const drivelist = require('drivelist');

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

async function testDriveSpeed(mountPath) {
    const testFileSize = 50 * 1024 * 1024; // 50MB
    const tempFile = path.join(mountPath, 'speedtest.tmp');
    
    let writeSpeed = 0;
    let readSpeed = 0;
    
    try {
        const buffer = crypto.randomBytes(testFileSize);
        
        // Write Test
        const startWrite = process.hrtime.bigint();
        fs.writeFileSync(tempFile, buffer);
        const endWrite = process.hrtime.bigint();
        
        const writeTimeSec = Number(endWrite - startWrite) / 1e9;
        writeSpeed = (testFileSize / 1024 / 1024) / writeTimeSec;
        
        // Read Test
        const startRead = process.hrtime.bigint();
        fs.readFileSync(tempFile);
        const endRead = process.hrtime.bigint();
        
        const readTimeSec = Number(endRead - startRead) / 1e9;
        readSpeed = (testFileSize / 1024 / 1024) / readTimeSec;
        
    } catch (e) {
        console.error(`Failed to test speed on ${mountPath}:`, e.message);
        // If it's a read-only file system, we can't test it this way
    } finally {
        if (fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {}
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
        
        const newStatus = [];
        
        for (const drive of externalDrives) {
            if (drive.mountpoints && drive.mountpoints.length > 0) {
                const mountPath = drive.mountpoints[0].path;
                const label = path.basename(mountPath);
                const capacity = (drive.size / (1024 * 1024 * 1024)).toFixed(2);
                const name = drive.description || 'USB Drive';
                
                let speeds;
                
                // Check if we have cached data and we are not forcing a refresh
                if (!forceTest && cache[mountPath]) {
                    console.log(`Using cached speed for ${mountPath}`);
                    speeds = cache[mountPath].speeds;
                } else {
                    console.log(`Testing speed for ${mountPath}...`);
                    speeds = await testDriveSpeed(mountPath);
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
            }
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
        
        // Broadcast new data to all clients
        io.emit('usbStatus', usbStatus);
    } catch (e) {
        console.error('Error updating USB status:', e);
    } finally {
        isTesting = false;
        io.emit('testing', false);
    }
}

// Watch for USB mount/unmount in macOS
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
            // Do not force test on auto-detect, rely on cache if available
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
