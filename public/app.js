document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    
    const usbContainer = document.getElementById('usb-container');
    const emptyState = document.getElementById('empty-state');
    const loadingState = document.getElementById('loading');
    const refreshBtn = document.getElementById('refreshBtn');

    // Time ago formatter
    function timeSince(date) {
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);
        let interval = seconds / 31536000;
        if (interval > 1) return Math.floor(interval) + " years ago";
        interval = seconds / 2592000;
        if (interval > 1) return Math.floor(interval) + " months ago";
        interval = seconds / 86400;
        if (interval > 1) return Math.floor(interval) + " days ago";
        interval = seconds / 3600;
        if (interval > 1) return Math.floor(interval) + " hours ago";
        interval = seconds / 60;
        if (interval > 1) return Math.floor(interval) + " minutes ago";
        if (seconds < 10) return "just now";
        return Math.floor(seconds) + " seconds ago";
    }

    // Format speed dynamically (MB/s -> GB/s if > 1024)
    function formatSpeed(speedStr) {
        let speed = parseFloat(speedStr);
        if (speed >= 1024) {
            return { value: (speed / 1024).toFixed(2), unit: 'GB/s' };
        }
        return { value: speed.toFixed(2), unit: 'MB/s' };
    }

    function createUsbCard(drive) {
        const readFormat = formatSpeed(drive.readSpeed);
        const writeFormat = formatSpeed(drive.writeSpeed);
        
        return `
            <div class="usb-card">
                <div class="card-header">
                    <div class="drive-info">
                        <h3>${drive.label || drive.name}</h3>
                        <span class="drive-path">${drive.name}</span>
                    </div>
                    <div class="capacity-badge">${drive.capacity}</div>
                </div>
                
                <div class="speed-metrics">
                    <div class="metric-box">
                        <div class="metric-label">Read Speed</div>
                        <div class="metric-value">${readFormat.value} <span class="metric-unit">${readFormat.unit}</span></div>
                    </div>
                    <div class="metric-box">
                        <div class="metric-label">Write Speed</div>
                        <div class="metric-value">${writeFormat.value} <span class="metric-unit">${writeFormat.unit}</span></div>
                    </div>
                </div>

                <div class="card-footer">
                    <div>
                        <span class="status-dot"></span> Online & Tested
                    </div>
                    <div class="time-ago" data-time="${drive.lastUpdated}">${timeSince(drive.lastUpdated)}</div>
                </div>
            </div>
        `;
    }

    function renderDrives(drives) {
        if (!drives || drives.length === 0) {
            usbContainer.innerHTML = '';
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
            usbContainer.innerHTML = drives.map(createUsbCard).join('');
        }
    }

    // Socket listeners
    socket.on('usbStatus', (drives) => {
        renderDrives(drives);
    });

    socket.on('testing', (isTesting) => {
        if (isTesting) {
            refreshBtn.classList.add('spinning');
            refreshBtn.disabled = true;
            loadingState.classList.remove('hidden');
            // Hide empty state if loading, but keep current drives visible
            if (usbContainer.innerHTML.trim() === '') {
                emptyState.classList.add('hidden');
            }
        } else {
            refreshBtn.classList.remove('spinning');
            refreshBtn.disabled = false;
            loadingState.classList.add('hidden');
        }
    });

    socket.on('connect_error', () => {
        emptyState.classList.remove('hidden');
        emptyState.querySelector('h2').textContent = "Connection Lost";
        emptyState.querySelector('p').textContent = "Reconnecting to the server...";
        usbContainer.innerHTML = '';
    });

    refreshBtn.addEventListener('click', () => {
        socket.emit('requestRefresh');
    });

    // Auto update "time ago" UI every minute without fetching data
    setInterval(() => {
        document.querySelectorAll('.time-ago').forEach(el => {
            const time = el.getAttribute('data-time');
            if (time) {
                el.textContent = timeSince(time);
            }
        });
    }, 60000);
});
