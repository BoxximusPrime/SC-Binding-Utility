/**
 * Update Checker Module
 * Checks GitHub releases for new versions and displays an indicator in the header
 */

const { invoke } = window.__TAURI__.core;

const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
const GITHUB_REPO = 'BoxximusPrime/SC-Binding-Utility';
const RELEASES_PAGE = 'https://github.com/BoxximusPrime/SC-Binding-Utility/releases';

// Get current app version from the HTML
function getCurrentVersion()
{
    const versionEl = document.getElementById('app-version');
    if (!versionEl) return '0.0.0';

    const text = versionEl.textContent.trim();
    // Remove 'v' prefix if present (e.g., "v0.4.1" -> "0.4.1")
    return text.startsWith('v') ? text.substring(1) : text;
}

// Compare two semantic versions
// Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
function compareVersions(v1, v2)
{
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++)
    {
        const part1 = parts1[i] || 0;
        const part2 = parts2[i] || 0;

        if (part1 < part2) return -1;
        if (part1 > part2) return 1;
    }

    return 0;
}

// Fetch the latest release from GitHub
async function fetchLatestRelease()
{
    try
    {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            method: 'GET',
            headers: {
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!response.ok)
        {
            console.warn(`GitHub API returned status ${response.status}`);
            return null;
        }

        const data = await response.json();

        // Extract version from tag_name (e.g., "v0.5.0" -> "0.5.0")
        let version = data.tag_name || '';
        if (version.startsWith('v'))
        {
            version = version.substring(1);
        }

        return {
            version,
            url: data.html_url,
            releaseName: data.name || version
        };
    } catch (error)
    {
        console.warn('Failed to fetch latest release from GitHub:', error);
        return null;
    }
}

// Show update indicator in the header
function showUpdateIndicator(latestVersion)
{
    const updateInfoEl = document.getElementById('update-info');
    if (!updateInfoEl) return;

    // Clear any existing badge first
    updateInfoEl.innerHTML = '';

    // Create and add update badge
    const badge = document.createElement('span');
    badge.className = 'update-badge';
    badge.title = `Update available: v${latestVersion}`;
    badge.innerHTML = '⬆️ Update Available';
    badge.style.cursor = 'pointer';
    badge.style.animation = 'pulse 2s infinite';
    badge.style.width = '160px';

    // Click to open releases page
    badge.addEventListener('click', async (e) =>
    {
        e.preventDefault();
        e.stopPropagation();
        try
        {
            await invoke('open_url', { url: RELEASES_PAGE });
        } catch (error)
        {
            console.error('Failed to open releases page:', error);
        }
    });

    updateInfoEl.appendChild(badge);
}

// Remove update indicator from the header
function hideUpdateIndicator()
{
    const updateInfoEl = document.getElementById('update-info');
    if (!updateInfoEl) return;

    updateInfoEl.innerHTML = '';
}

// Check for updates
async function checkForUpdates()
{
    const latestRelease = await fetchLatestRelease();

    if (!latestRelease)
    {
        console.log('Could not fetch latest release info');
        return;
    }

    const currentVersion = getCurrentVersion();
    console.log(`Current version: ${currentVersion}, Latest version: ${latestRelease.version}`);

    // Compare versions
    if (compareVersions(currentVersion, latestRelease.version) < 0)
    {
        console.log(`Update available: v${latestRelease.version}`);
        showUpdateIndicator(latestRelease.version);

        // Store update info for potential later use
        localStorage.setItem('latestVersion', latestRelease.version);
        localStorage.setItem('updateCheckTime', Date.now().toString());
    } else
    {
        console.log('App is up to date');
        hideUpdateIndicator();
    }
}

// Check if we should run an update check based on the interval
function shouldCheckForUpdates()
{
    const lastCheckTime = localStorage.getItem('updateCheckTime');

    if (!lastCheckTime)
    {
        return true; // First check
    }

    const timeSinceLastCheck = Date.now() - parseInt(lastCheckTime);
    return timeSinceLastCheck > UPDATE_CHECK_INTERVAL;
}

// Initialize the update checker
export async function initializeUpdateChecker()
{
    console.log('Initializing update checker...');

    // Check on startup if enough time has passed
    if (shouldCheckForUpdates())
    {
        await checkForUpdates();
    } else
    {
        // Restore any previously detected update indicator
        const latestVersion = localStorage.getItem('latestVersion');
        if (latestVersion && compareVersions(getCurrentVersion(), latestVersion) < 0)
        {
            showUpdateIndicator(latestVersion);
        }
    }

    // Set up periodic checks every 4 hours
    setInterval(() =>
    {
        checkForUpdates().catch(err =>
        {
            console.error('Error in update check interval:', err);
        });
    }, UPDATE_CHECK_INTERVAL);

    // DEV: Key combo to show mock update (Ctrl+Alt+R, then T) - COMMENTED OUT FOR LIVE RELEASE
    // let devKeySequence = [];
    // window.addEventListener('keydown', (e) =>
    // {
    //     if (e.ctrlKey && e.altKey && e.code === 'KeyR')
    //     {
    //         devKeySequence = ['ctrl_alt_r'];
    //         console.log('[DEV] Step 1: Ctrl+Alt+R detected');
    //     } else if (devKeySequence.includes('ctrl_alt_r') && e.code === 'KeyT')
    //     {
    //         e.preventDefault();
    //         console.log('[DEV] Step 2: T detected - showing mock update v0.9.0');
    //         showUpdateIndicator('0.9.0');
    //         devKeySequence = [];
    //     } else if (!e.ctrlKey && !e.altKey)
    //     {
    //         // Reset sequence if user presses any other key combo
    //         if (devKeySequence.length > 0)
    //         {
    //             devKeySequence = [];
    //         }
    //     }
    // });
}

