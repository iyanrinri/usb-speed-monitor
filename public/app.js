document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    
    const usbContainer = document.getElementById('usb-container');
    const emptyState = document.getElementById('empty-state');
    const loadingState = document.getElementById('loading');
    const refreshBtn = document.getElementById('refreshBtn');
    const searchInput = document.getElementById('searchInput');

    let allDrives = [];

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

    function estimateClass(writeSpeedStr) {
        let speed = parseFloat(writeSpeedStr);
        if (speed >= 90) return 'Est. V90';
        if (speed >= 60) return 'Est. V60';
        if (speed >= 30) return 'Est. U3 / V30';
        if (speed >= 10) return 'Est. Class 10 / U1';
        if (speed >= 6) return 'Est. Class 6';
        if (speed >= 4) return 'Est. Class 4';
        return 'Est. Class 2';
    }

    function createUsbCard(drive) {
        const readFormat = formatSpeed(drive.readSpeed);
        const estClass = estimateClass(drive.readSpeed);
        
        return `
            <div class="usb-card">
                <div class="card-header">
                    <div class="drive-info">
                        <h3>${drive.label || drive.name}</h3>
                        <span class="drive-path">${drive.name}</span>
                    </div>
                    <div class="badges-group" style="display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-end;">
                        <div class="capacity-badge">${drive.capacity}</div>
                        <div class="class-badge" style="background: rgba(99, 102, 241, 0.1); color: var(--accent-color); padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.6rem; font-weight: 600; border: 1px solid rgba(99, 102, 241, 0.2); white-space: nowrap;">${estClass}</div>
                    </div>
                </div>
                
                <div class="speed-metrics">
                    <div class="metric-box">
                        <div class="metric-label">Read Speed</div>
                        <div class="metric-value">${readFormat.value} <span class="metric-unit">${readFormat.unit}</span></div>
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

    function getSpeedCategory(readSpeedStr) {
        let speed = parseFloat(readSpeedStr);
        if (speed >= 60) return 'fast';
        if (speed > 30) return 'normal';
        return 'slow';
    }

    function renderDrives(drives) {
        if (!drives || drives.length === 0) {
            usbContainer.innerHTML = '';
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
            
            const groups = {
                fast: [],
                normal: [],
                slow: []
            };

            drives.forEach(drive => {
                groups[getSpeedCategory(drive.readSpeed)].push(drive);
            });

            let html = '';

            if (groups.fast.length > 0) {
                html += `
                    <div class="speed-group">
                        <h2 class="group-title" style="color: var(--success); margin: 2rem 0 1rem; font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--card-border);">
                            🚀 Fast Speed Detected (≥ 60 MB/s)
                        </h2>
                        <div class="usb-grid">
                            ${groups.fast.map(createUsbCard).join('')}
                        </div>
                    </div>
                `;
            }

            if (groups.normal.length > 0) {
                html += `
                    <div class="speed-group">
                        <h2 class="group-title" style="color: #3b82f6; margin: 2rem 0 1rem; font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--card-border);">
                            ✅ Normal Speed (> 30 - 59 MB/s)
                        </h2>
                        <div class="usb-grid">
                            ${groups.normal.map(createUsbCard).join('')}
                        </div>
                    </div>
                `;
            }

            if (groups.slow.length > 0) {
                html += `
                    <div class="speed-group">
                        <h2 class="group-title" style="color: #ef4444; margin: 2rem 0 1rem; font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--card-border);">
                            🐢 Slow Speed Detected (≤ 30 MB/s)
                        </h2>
                        <div class="usb-grid">
                            ${groups.slow.map(createUsbCard).join('')}
                        </div>
                    </div>
                `;
            }

            usbContainer.innerHTML = html;
        }
    }

    // Socket listeners
    socket.on('usbStatus', (drives) => {
        allDrives = drives;
        applySearchFilter();
    });

    searchInput.addEventListener('input', () => {
        applySearchFilter();
    });

    function applySearchFilter() {
        if (!searchInput) return;
        const searchTerm = searchInput.value.toLowerCase();
        const filteredDrives = allDrives.filter(drive => {
            const label = (drive.label || '').toLowerCase();
            const name = (drive.name || '').toLowerCase();
            return label.includes(searchTerm) || name.includes(searchTerm);
        });
        renderDrives(filteredDrives);
    }

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
            const progressEl = document.getElementById('loading-progress');
            if (progressEl) progressEl.textContent = '';
        }
    });

    socket.on('testing_progress', (data) => {
        const progressEl = document.getElementById('loading-progress');
        if (progressEl) {
            progressEl.textContent = `${data.completed} / ${data.total} completed`;
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
