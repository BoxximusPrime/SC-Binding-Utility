const { invoke } = window.__TAURI__.core;
const { open, save } = window.__TAURI__.dialog;
import { loadPersistedKeybindings } from './keybindings-page.js';
import { toStarCitizenFormat } from './input-utils.js';
import { initializeUpdateChecker } from './update-checker.js';
import { Tooltip } from './tooltip.js';
import { CustomDropdown } from './custom-dropdown.js';
import patchNotesData from './patch-notes.json';

// Global error handler for uncaught errors
window.addEventListener('error', async (event) =>
{
  console.error('Uncaught error:', event.error);
  try
  {
    await invoke('log_error', {
      message: event.error?.message || event.message || 'Unknown error',
      stack: event.error?.stack || null
    });
  } catch (e)
  {
    console.error('Failed to log error to backend:', e);
  }
});

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', async (event) =>
{
  console.error('Unhandled promise rejection:', event.reason);
  try
  {
    await invoke('log_error', {
      message: event.reason?.message || String(event.reason) || 'Unknown promise rejection',
      stack: event.reason?.stack || null
    });
  } catch (e)
  {
    console.error('Failed to log promise rejection to backend:', e);
  }
});

// Global handler for external links to open in default browser
document.addEventListener('click', async (e) =>
{
  const anchor = e.target.closest('a');
  if (anchor && (anchor.target === '_blank' || anchor.classList.contains('external-link')))
  {
    // Only intercept if it's an http/https link
    if (anchor.href.startsWith('http'))
    {
      e.preventDefault();
      try
      {
        await invoke('open_url', { url: anchor.href });
      } catch (err)
      {
        console.error('Failed to open external link:', err);
        // Fallback
        window.open(anchor.href, '_blank');
      }
    }
  }
});

// Helper function to log error messages (exported for use by other modules)
window.logError = async (message, stack = null) =>
{
  console.error(message);
  try
  {
    await invoke('log_error', { message, stack });
  } catch (e)
  {
    console.error('Failed to log error to backend:', e);
  }
};

// Helper function to log info messages
window.logInfo = async (message) =>
{
  console.log(message);
  try
  {
    await invoke('log_info', { message });
  } catch (e)
  {
    console.error('Failed to log info to backend:', e);
  }
};

// State
let currentTab = 'main';

function setBindingSaveEnabled(enabled)
{
  if (!bindingModalSaveBtn) return;
  bindingModalSaveBtn.disabled = !enabled;
}





// ============================================================================
// CUSTOM CONFIRMATION DIALOG
// ============================================================================

/**
 * Show a custom confirmation dialog
 * @param {string} message - The confirmation message to display
 * @param {string} title - Optional title for the dialog (default: "Confirm Action")
 * @param {string} confirmText - Optional text for confirm button (default: "Confirm")
 * @param {string} cancelText - Optional text for cancel button (default: "Cancel")
 * @returns {Promise<boolean>} - Resolves to true if confirmed, false if cancelled
 */
async function showConfirmation(message, title = "Confirm Action", confirmText = "Confirm", cancelText = "Cancel", confirmBtnClass = "btn-primary")
{
  return new Promise((resolve) =>
  {
    const modal = document.getElementById('confirmation-modal');
    const titleEl = document.getElementById('confirmation-title');
    const messageEl = document.getElementById('confirmation-message');
    const confirmBtn = document.getElementById('confirmation-confirm-btn');
    const cancelBtn = document.getElementById('confirmation-cancel-btn');

    // Set content
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    // Reset and apply button classes
    confirmBtn.className = 'btn ' + confirmBtnClass;
    cancelBtn.className = 'btn btn-secondary';

    // Show modal
    modal.style.display = 'flex';

    // Handle confirm
    const handleConfirm = () =>
    {
      cleanup();
      resolve(true);
    };

    // Handle cancel
    const handleCancel = () =>
    {
      cleanup();
      resolve(false);
    };

    // Handle escape key
    const handleEscape = (e) =>
    {
      if (e.key === 'Escape')
      {
        handleCancel();
      }
    };

    // Cleanup function
    const cleanup = () =>
    {
      modal.style.display = 'none';
      confirmBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
      document.removeEventListener('keydown', handleEscape);
    };

    // Add event listeners
    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    document.addEventListener('keydown', handleEscape);

    // Focus confirm button
    setTimeout(() => confirmBtn.focus(), 100);
  });
}

async function showAlert(message, title = "Information", buttonText = "OK")
{
  return new Promise((resolve) =>
  {
    const modal = document.getElementById('confirmation-modal');
    const titleEl = document.getElementById('confirmation-title');
    const messageEl = document.getElementById('confirmation-message');
    const confirmBtn = document.getElementById('confirmation-confirm-btn');
    const cancelBtn = document.getElementById('confirmation-cancel-btn');

    // Set content
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = buttonText;

    // Hide cancel button for alert
    cancelBtn.style.display = 'none';

    // Show modal
    modal.style.display = 'flex';

    // Handle confirm
    const handleConfirm = () =>
    {
      cleanup();
      resolve();
    };

    // Handle escape key
    const handleEscape = (e) =>
    {
      if (e.key === 'Escape')
      {
        handleConfirm();
      }
    };

    // Cleanup function
    const cleanup = () =>
    {
      modal.style.display = 'none';
      cancelBtn.style.display = '';
      confirmBtn.removeEventListener('click', handleConfirm);
      document.removeEventListener('keydown', handleEscape);
    };

    // Add event listeners
    confirmBtn.addEventListener('click', handleConfirm);
    document.addEventListener('keydown', handleEscape);

    // Focus confirm button
    setTimeout(() => confirmBtn.focus(), 100);
  });
}

// Make showConfirmation and showAlert globally available for other modules
window.showConfirmation = showConfirmation;
window.showAlert = showAlert;

// ============================================================================
// WHAT'S NEW MODAL
// ============================================================================

function parseSeriesValue(series)
{
  const [majorPart = '0', minorPart = '0'] = String(series).split('.');
  return {
    major: Number.parseInt(majorPart, 10) || 0,
    minor: Number.parseInt(minorPart, 10) || 0
  };
}

function compareSeriesDescending(leftSeries, rightSeries)
{
  const left = parseSeriesValue(leftSeries);
  const right = parseSeriesValue(rightSeries);

  if (left.major !== right.major)
  {
    return right.major - left.major;
  }

  return right.minor - left.minor;
}

function parseVersionValue(version)
{
  const [majorPart = '0', minorPart = '0', patchPart = '0'] = String(version).split('.');
  return {
    major: Number.parseInt(majorPart, 10) || 0,
    minor: Number.parseInt(minorPart, 10) || 0,
    patch: Number.parseInt(patchPart, 10) || 0
  };
}

function compareVersionsDescending(leftVersion, rightVersion)
{
  const left = parseVersionValue(leftVersion);
  const right = parseVersionValue(rightVersion);

  if (left.major !== right.major)
  {
    return right.major - left.major;
  }

  if (left.minor !== right.minor)
  {
    return right.minor - left.minor;
  }

  return right.patch - left.patch;
}

function getReleaseSeries(version)
{
  const [majorPart = '0', minorPart = '0'] = String(version).split('.');
  return `${Number.parseInt(majorPart, 10) || 0}.${Number.parseInt(minorPart, 10) || 0}`;
}

function getVisiblePatchNoteGroups(currentVersion, maxGroups = 2)
{
  const currentSeries = getReleaseSeries(currentVersion);
  const groupedReleaseMap = new Map();

  (patchNotesData.releases || []).forEach(release =>
  {
    const series = getReleaseSeries(release.version);

    if (!groupedReleaseMap.has(series))
    {
      groupedReleaseMap.set(series, []);
    }

    groupedReleaseMap.get(series).push(release);
  });

  const sortedGroups = [...groupedReleaseMap.entries()]
    .map(([series, releases]) => ({
      series,
      label: `v${series}.x`,
      releases: [...releases].sort((left, right) => compareVersionsDescending(left.version, right.version))
    }))
    .sort((left, right) => compareSeriesDescending(left.series, right.series));

  const currentIndex = sortedGroups.findIndex(group => group.series === currentSeries);

  if (currentIndex === -1)
  {
    return sortedGroups.slice(0, maxGroups);
  }

  return sortedGroups.slice(currentIndex, currentIndex + maxGroups);
}

function createWhatsNewList(items)
{
  const list = document.createElement('ul');

  items.forEach(item =>
  {
    const listItem = document.createElement('li');
    listItem.innerHTML = item;
    list.appendChild(listItem);
  });

  return list;
}

function renderPatchNoteSection(title, items)
{
  if (!Array.isArray(items) || items.length === 0) return null;

  const wrapper = document.createElement('div');

  if (title)
  {
    const heading = document.createElement('h3');
    heading.textContent = title;
    wrapper.appendChild(heading);
  }

  wrapper.appendChild(createWhatsNewList(items));

  return wrapper.childElementCount > 0 ? wrapper : null;
}

function renderPatchNoteRelease(release)
{
  const releaseFragment = document.createDocumentFragment();
  const releaseHeading = document.createElement('h3');
  releaseHeading.textContent = `v${release.version}`;
  releaseFragment.appendChild(releaseHeading);

  Object.entries(release.notes || {}).forEach(([title, items]) =>
  {
    const sectionElement = renderPatchNoteSection(title, items);

    if (sectionElement)
    {
      releaseFragment.appendChild(sectionElement);
    }
  });

  return releaseFragment;
}

function renderWhatsNewContent(currentVersion)
{
  const container = document.getElementById('whats-new-content');
  if (!container) return;

  container.innerHTML = '';

  const visibleGroups = getVisiblePatchNoteGroups(currentVersion, 2);

  visibleGroups.forEach(group =>
  {
    const section = document.createElement('div');
    section.className = 'whats-new-version-section';

    const toggleButton = document.createElement('button');
    toggleButton.className = 'whats-new-version-toggle';
    toggleButton.dataset.target = `whats-new-${group.series.replace(/\./g, '-')}`;
    toggleButton.type = 'button';

    const arrow = document.createElement('span');
    arrow.className = 'version-toggle-arrow';
    arrow.textContent = '▼';

    const label = document.createElement('span');
    label.className = 'version-toggle-label';
    label.textContent = group.label;

    toggleButton.appendChild(arrow);
    toggleButton.appendChild(label);

    const content = document.createElement('div');
    content.className = 'whats-new-version-content';
    content.id = toggleButton.dataset.target;
    content.style.display = 'block';

    const contentSection = document.createElement('div');
    contentSection.className = 'whats-new-section';

    (group.releases || []).forEach(release =>
    {
      contentSection.appendChild(renderPatchNoteRelease(release));
    });

    content.appendChild(contentSection);
    section.appendChild(toggleButton);
    section.appendChild(content);
    container.appendChild(section);
  });
}

function initializeWhatsNewModal()
{
  const CURRENT_VERSION = '1.2.2';
  const WHATS_NEW_KEY = 'whatsNew';

  renderWhatsNewContent(CURRENT_VERSION);

  // Check if the stored version matches the current version
  const storedVersion = localStorage.getItem(WHATS_NEW_KEY);

  if (storedVersion !== CURRENT_VERSION)
  {
    // Show the modal if version has changed or never been set
    showWhatsNewModal();
  }
}

function showWhatsNewModal()
{
  const CURRENT_VERSION = '1.2.2';
  const WHATS_NEW_KEY = 'whatsNew';

  const modal = document.getElementById('whats-new-modal');
  const closeBtn = document.getElementById('whats-new-close-btn');

  if (!modal || !closeBtn) return;

  // Show modal
  modal.style.display = 'flex';

  // Handle close
  const handleClose = () =>
  {
    modal.style.display = 'none';
    localStorage.setItem(WHATS_NEW_KEY, CURRENT_VERSION);
    closeBtn.removeEventListener('click', handleClose);
    escapeHandler && document.removeEventListener('keydown', escapeHandler);
  };

  // Handle escape key
  const escapeHandler = (e) =>
  {
    if (e.key === 'Escape')
    {
      handleClose();
    }
  };

  closeBtn.addEventListener('click', handleClose);
  document.addEventListener('keydown', escapeHandler);

  // Focus the close button
  setTimeout(() => closeBtn.focus(), 100);

  // Setup version toggle handlers
  setupWhatsNewToggles();
}

function setupWhatsNewToggles()
{
  const toggleButtons = document.querySelectorAll('.whats-new-version-toggle');

  toggleButtons.forEach(button =>
  {
    // Remove any existing listeners to avoid duplicates
    const newButton = button.cloneNode(true);
    button.parentNode.replaceChild(newButton, button);

    newButton.addEventListener('click', (e) =>
    {
      e.preventDefault();
      e.stopPropagation();

      const contentId = newButton.dataset.target;
      const content = document.getElementById(contentId);
      const arrow = newButton.querySelector('.version-toggle-arrow');

      if (!content || !arrow)
      {
        console.warn(`Could not find patch notes content for target: ${contentId}`);
        return;
      }

      const isHidden = content.style.display === 'none';

      // Toggle display
      content.style.display = isHidden ? 'block' : 'none';

      // Animate arrow - rotate 90 degrees when closing
      if (isHidden)
      {
        arrow.style.transform = 'rotate(0deg)';
      } else
      {
        arrow.style.transform = 'rotate(-90deg)';
      }
    });
  });
}

// Make showWhatsNewModal globally available for testing
window.showWhatsNewModal = showWhatsNewModal;

// Main app initialization
window.addEventListener("DOMContentLoaded", async () =>
{
  // Load device prefix mappings early (before any device detection happens)
  if (window.loadDevicePrefixMappings)
  {
    window.loadDevicePrefixMappings();
  }

  // Build device UUID mapping early (before keybindings are loaded)
  if (window.buildDeviceUuidMapping)
  {
    await window.buildDeviceUuidMapping();
  }

  initializeEventListeners();
  initializeTabSystem();
  initializeHelpNavigation();
  initializeHelpWizard();
  initializeSplitResizer();
  initializeBindingsSidebar();
  initializeBindingsPanelResponsiveness();
  initializeWhatsNewModal();
  initializeFontSizeScaling();

  // Initialize tooltip settings from localStorage
  const savedTooltipSetting = localStorage.getItem('tooltips-enabled');
  // Default to enabled (true) if not set
  Tooltip.enabled = savedTooltipSetting !== 'false';

  const tooltipsToggle = document.getElementById('tooltips-toggle');
  if (tooltipsToggle)
  {
    tooltipsToggle.checked = Tooltip.enabled;
    tooltipsToggle.addEventListener('change', () =>
    {
      Tooltip.enabled = tooltipsToggle.checked;
      localStorage.setItem('tooltips-enabled', tooltipsToggle.checked);
    });
  }

  // Initialize tips visibility setting from localStorage
  const savedTipsDisabled = localStorage.getItem('tips-disabled') === 'true';
  document.body.classList.toggle('tips-hidden', savedTipsDisabled);

  const disableTipsToggle = document.getElementById('disable-tips-toggle');
  if (disableTipsToggle)
  {
    disableTipsToggle.checked = savedTipsDisabled;
    disableTipsToggle.addEventListener('change', () =>
    {
      const isDisabled = disableTipsToggle.checked;
      document.body.classList.toggle('tips-hidden', isDisabled);
      localStorage.setItem('tips-disabled', isDisabled);
    });
  }

  // Initialize tooltips
  const searchInput = document.getElementById('search-input');
  if (searchInput)
  {
    new Tooltip(searchInput, 'Type to filter actions by name. Supports partial matches. Use | for OR (any term), use + for AND (all terms).');
  }

  // Main header tabs
  const tabWelcome = document.getElementById('tab-welcome');
  if (tabWelcome) { new Tooltip(tabWelcome, 'Welcome & Getting Started'); }

  const tabBindings = document.getElementById('tab-bindings');
  if (tabBindings) { new Tooltip(tabBindings, 'View & Edit Keybindings'); }

  const tabTemplate = document.getElementById('tab-template');
  if (tabTemplate) { new Tooltip(tabTemplate, 'Create & Edit Templates'); }

  const tabDebugger = document.getElementById('tab-debugger');
  if (tabDebugger) { new Tooltip(tabDebugger, 'Map and test input devices. Useful if your input devices don\'t match star citizen\'s expected inputs'); }

  const tabCharacter = document.getElementById('tab-character');
  if (tabCharacter) { new Tooltip(tabCharacter, 'Manage Character Appearances'); }

  const tabHelp = document.getElementById('tab-help');
  if (tabHelp) { new Tooltip(tabHelp, 'Help & Keyboard Shortcuts'); }

  const tabSettings = document.getElementById('tab-settings');
  if (tabSettings) { new Tooltip(tabSettings, 'Settings & Debug Options'); }

  const smartFilterHelp = document.getElementById('smart-filter-help');
  if (smartFilterHelp)
  {
    new Tooltip(smartFilterHelp, 'Smart filters are keyword-based, so results can be imperfect. Use them as a hint, not a guarantee.');
  }

  // Action buttons in keybindings sidebar
  const newKeybindingBtn = document.getElementById('new-keybinding-btn');
  if (newKeybindingBtn) { new Tooltip(newKeybindingBtn, 'Start with a fresh keybinding set'); }

  const configureJoystickBtn = document.getElementById('configure-joystick-mapping-btn');
  if (configureJoystickBtn) { new Tooltip(configureJoystickBtn, 'Open Device Manager to configure device IDs and test inputs'); }

  const clearSCBindsBtn = document.getElementById('clear-sc-binds-btn');
  if (clearSCBindsBtn) { new Tooltip(clearSCBindsBtn, 'Generate a keybinding file that forcefully unbinds all actions in-game'); }

  const swapJoystickPrefixesBtn = document.getElementById('swap-joystick-prefixes-btn');
  if (swapJoystickPrefixesBtn) { new Tooltip(swapJoystickPrefixesBtn, 'Swap device prefixes on all bindings - useful when Star Citizen flips device order'); }

  const restoreDefaultsBtn = document.getElementById('restore-defaults-btn');
  if (restoreDefaultsBtn) { new Tooltip(restoreDefaultsBtn, 'Generate a profile with only default bindings'); }

  // Bindings sub-nav tooltips
  const listViewBtn = document.getElementById('bindings-view-list');
  if (listViewBtn) { new Tooltip(listViewBtn, 'View keybindings as a filterable list'); }

  const visualViewBtn = document.getElementById('bindings-view-visual');
  if (visualViewBtn) { new Tooltip(visualViewBtn, 'View keybindings on a visual joystick layout'); }

  const splitViewBtn = document.getElementById('bindings-view-split');
  if (splitViewBtn) { new Tooltip(splitViewBtn, 'View both keybindings and the visual view'); }

  const controlsViewBtn = document.getElementById('bindings-view-controls');
  if (controlsViewBtn) { new Tooltip(controlsViewBtn, 'Edit controller settings for inversion, and curves'); }

  // Filter checkbox tooltips
  const customizedWrapper = document.getElementById('customized-only-wrapper');
  if (customizedWrapper) { new Tooltip(customizedWrapper, 'When enabled, only shows actions that have been customized by the user. When disabled, shows all available actions.'); }

  const showUnboundWrapper = document.getElementById('show-unbound-wrapper');
  if (showUnboundWrapper) { new Tooltip(showUnboundWrapper, 'When enabled, includes actions that have no bindings assigned. When disabled, hides actions without any bindings.'); }

  // Initialize custom dropdown for activation mode with tooltips
  const activationModeSelect = document.getElementById('activation-mode-select');
  if (activationModeSelect)
  {
    const activationModeTooltips = {
      '': 'Default behavior - activates on button press',
      'press': 'Standard press activation',
      'press_quicker': 'Press with reduced response time',
      'delayed_press': 'Waits before activating (standard delay)',
      'delayed_press_medium': 'Waits before activating (medium delay)',
      'delayed_press_long': 'Waits before activating (long delay)',
      'tap': 'Quick tap to activate',
      'tap_quicker': 'Quick tap with reduced response time',
      'double_tap': 'Requires two quick taps to activate',
      'double_tap_nonblocking': 'Double tap that allows continuous input',
      'hold': 'Activate by holding the button down',
      'delayed_hold': 'Hold with a delay before activation',
      'delayed_hold_long': 'Hold with a longer delay before activation',
      'hold_no_retrigger': 'Hold without repeating while held',
      'hold_toggle': 'Toggle between on/off by holding',
      'smart_toggle': 'Intelligent toggle based on input pattern',
      'all': 'Activate on any input type'
    };

    window.activationModeDropdown = new CustomDropdown(activationModeSelect, {
      optionTooltips: activationModeTooltips
    });
  }

  // Initialize update checker
  try
  {
    await initializeUpdateChecker();
  } catch (error)
  {
    console.error('Failed to initialize update checker:', error);
    // Don't block app startup if update checker fails
  }

  // Show default file indicator in both locations
  const indicator = document.getElementById('loaded-file-indicator');
  if (indicator) indicator.style.display = 'flex';
  const indicatorSub = document.getElementById('loaded-file-indicator-sub');
  if (indicatorSub) indicatorSub.style.display = 'flex';

  // Load persisted template name based on which tab was last active
  const lastTab = localStorage.getItem('currentTab') || 'welcome';

  if (lastTab === 'template')
  {
    // Template editor was last active - load its template
    const savedTemplateName = localStorage.getItem('currentTemplateName');
    if (savedTemplateName)
    {
      const savedFileName = localStorage.getItem('editorTemplateFileName');
      updateTemplateIndicator(savedTemplateName, savedFileName);
    }
  }
  else if (lastTab === 'bindings')
  {
    // Visual viewer might have been active - check if it has a template
    const viewerTemplateName = localStorage.getItem('viewerCurrentTemplateName');
    if (viewerTemplateName)
    {
      const viewerFileName = localStorage.getItem('viewerTemplateFileName');
      updateViewerTemplateIndicator(viewerTemplateName, viewerFileName);
    }
  }

  // Load categories
  try
  {
    if (window.loadCategoryMappings) await window.loadCategoryMappings();
  } catch (error)
  {
    console.error('Failed to load categories:', error);
  }

  // Load AllBinds.xml on startup
  try
  {
    await invoke('load_all_binds');
    console.log('AllBinds.xml loaded successfully');
  } catch (error)
  {
    console.error('Failed to load AllBinds.xml:', error);
    await showAlert(`Warning: Failed to load AllBinds.xml: ${error}\n\nSome features may not work correctly.`, 'Warning');
  }

  await loadPersistedKeybindings();

  // If split view was the last active view, refresh it now that keybindings are loaded
  const currentTab = localStorage.getItem('currentTab') || 'welcome';
  const currentBindingsView = localStorage.getItem('bindingsView') || 'list';
  if (currentTab === 'bindings' && currentBindingsView === 'split' && window.refreshVisualView)
  {
    console.log('Refreshing split view after loading keybindings...');
    await window.refreshVisualView(true); // true = preserve pan/zoom
  }
});

function initializeTabSystem()
{
  // Add tab click handlers
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn =>
  {
    btn.addEventListener('click', (e) =>
    {
      const tabName = e.target.dataset.tab;
      if (!tabName) return;
      switchTab(tabName);
    });
  });

  // Add bindings sub-navigation handlers
  document.querySelectorAll('.bindings-view-btn').forEach(btn =>
  {
    btn.addEventListener('click', (e) =>
    {
      const viewName = e.currentTarget.dataset.view;
      if (!viewName) return;
      switchBindingsView(viewName);
    });
  });

  // Save current tab to localStorage
  const savedTab = localStorage.getItem('currentTab') || 'welcome';
  const savedBindingsView = localStorage.getItem('bindingsView') || 'list';
  switchTab(savedTab);
  if (savedTab === 'bindings')
  {
    switchBindingsView(savedBindingsView);
  }

  // Initialize settings page elements
  initializeSettingsPage();
}

/**
 * Initialize the resizer for split view
 */
function initializeSplitResizer()
{
  const resizer = document.getElementById('bindings-split-resizer');
  const leftPane = document.getElementById('bindings-list-view');
  const rightPane = document.getElementById('bindings-visual-view');
  const wrapper = document.getElementById('bindings-views-wrapper');

  if (!resizer || !leftPane || !rightPane || !wrapper) return;

  let isDragging = false;

  // Load saved width from localStorage
  const savedWidth = localStorage.getItem('splitViewWidth');
  if (savedWidth)
  {
    const wrapperWidth = wrapper.getBoundingClientRect().width;
    const parsedWidth = Number.parseFloat(savedWidth);
    const clampedWidth = wrapperWidth > 400 && Number.isFinite(parsedWidth)
      ? Math.min(Math.max(parsedWidth, 200), wrapperWidth - 208)
      : parsedWidth;

    leftPane.style.flex = 'none';
    leftPane.style.width = Number.isFinite(clampedWidth) ? `${clampedWidth}px` : savedWidth;
  }

  resizer.addEventListener('mousedown', (e) =>
  {
    isDragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    // Prevent text selection while dragging
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) =>
  {
    if (!isDragging) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const newWidth = e.clientX - wrapperRect.left;

    // Constraints
    const minWidth = 200;
    const maxWidth = wrapperRect.width - 200;

    if (newWidth >= minWidth && newWidth <= maxWidth)
    {
      leftPane.style.flex = 'none';
      leftPane.style.width = `${newWidth}px`;
      localStorage.setItem('splitViewWidth', `${newWidth}px`);

      // Trigger a resize event for the visual view if it's active
      if (window.refreshVisualView)
      {
        window.refreshVisualView();
      }
    }
  });

  document.addEventListener('mouseup', () =>
  {
    if (isDragging)
    {
      isDragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/**
 * Initialize the collapsible filters sidebar shared by list and split views.
 */
function initializeBindingsSidebar()
{
  const sidebar = document.getElementById('bindings-sidebar');
  const toggle = document.getElementById('bindings-sidebar-toggle');
  const icon = toggle?.querySelector('.sidebar-toggle-icon');

  if (!sidebar || !toggle || !icon) return;

  const setCollapsed = (isCollapsed) =>
  {
    sidebar.classList.toggle('is-collapsed', isCollapsed);
    toggle.setAttribute('aria-expanded', String(!isCollapsed));

    const label = isCollapsed ? 'Restore filters sidebar' : 'Minimize filters sidebar';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    icon.textContent = isCollapsed ? '\u203a' : '\u2039';

    localStorage.setItem('bindingsSidebarCollapsed', String(isCollapsed));

    requestAnimationFrame(() =>
    {
      window.dispatchEvent(new Event('resize'));
      if (window.refreshVisualView && document.getElementById('tab-content-bindings')?.classList.contains('split-mode'))
      {
        window.refreshVisualView(true);
      }
    });
  };

  setCollapsed(localStorage.getItem('bindingsSidebarCollapsed') === 'true');
  toggle.addEventListener('click', () => setCollapsed(!sidebar.classList.contains('is-collapsed')));
}

/**
 * Reflow binding rows based on the list pane itself, not the full window width.
 * This keeps split view responsive as its resizer changes the available space.
 */
function initializeBindingsPanelResponsiveness()
{
  const panel = document.querySelector('#bindings-list-view .bindings-panel');
  const viewsWrapper = document.getElementById('bindings-views-wrapper');
  if (!panel) return;

  const updateLayout = () =>
  {
    const panelRect = panel.getBoundingClientRect();
    const wrapperRect = viewsWrapper?.getBoundingClientRect();
    const visibleLeft = Math.max(panelRect.left, wrapperRect?.left ?? panelRect.left, 0);
    const visibleRight = Math.min(panelRect.right, wrapperRect?.right ?? panelRect.right, window.innerWidth);
    const width = Math.max(0, visibleRight - visibleLeft);

    panel.classList.toggle('is-compact', width < 1000);
    panel.classList.toggle('is-stacked', width < 620);
  };

  updateLayout();

  if (typeof ResizeObserver === 'function')
  {
    const observer = new ResizeObserver(updateLayout);
    observer.observe(panel);
    if (viewsWrapper) observer.observe(viewsWrapper);
  }

  window.addEventListener('resize', updateLayout);
}

/**
 * Switch between list, visual, and controls views within the Bindings tab
 */
function switchBindingsView(viewName)
{
  if (!viewName) return;

  const bindingsTabContent = document.getElementById('tab-content-bindings');

  // Update active button
  document.querySelectorAll('.bindings-view-btn').forEach(btn =>
  {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Toggle split mode class (affects layout + visibility)
  if (bindingsTabContent)
  {
    bindingsTabContent.classList.toggle('split-mode', viewName === 'split');
  }

  // Update active view container
  document.querySelectorAll('.bindings-view-container').forEach(container =>
  {
    const isListView = container.id === 'bindings-list-view' && viewName === 'list';
    const isVisualView = container.id === 'bindings-visual-view' && viewName === 'visual';
    const isSplitListView = container.id === 'bindings-list-view' && viewName === 'split';
    const isSplitVisualView = container.id === 'bindings-visual-view' && viewName === 'split';
    const isControlsView = container.id === 'bindings-controls-view' && viewName === 'controls';
    container.classList.toggle('active', isListView || isVisualView || isControlsView || isSplitListView || isSplitVisualView);

    // Reset inline styles when not in split mode to allow CSS to take over
    if (viewName !== 'split')
    {
      container.style.flex = '';
      container.style.width = '';
    }
    else if (container.id === 'bindings-list-view')
    {
      // Re-apply saved width if switching back to split mode
      const savedWidth = localStorage.getItem('splitViewWidth');
      if (savedWidth)
      {
        const wrapper = document.getElementById('bindings-views-wrapper');
        const wrapperWidth = wrapper?.getBoundingClientRect().width || 0;
        const parsedWidth = Number.parseFloat(savedWidth);
        const clampedWidth = wrapperWidth > 400 && Number.isFinite(parsedWidth)
          ? Math.min(Math.max(parsedWidth, 200), wrapperWidth - 208)
          : parsedWidth;

        container.style.flex = 'none';
        container.style.width = Number.isFinite(clampedWidth) ? `${clampedWidth}px` : savedWidth;
      }
    }
  });

  // Save to localStorage
  localStorage.setItem('bindingsView', viewName);

  // If switching to visual view, initialize and refresh it
  if (viewName === 'visual' || viewName === 'split')
  {
    if (window.initializeVisualView)
    {
      window.initializeVisualView();
    }
    if (window.restoreViewerTransformForCurrentView)
    {
      window.restoreViewerTransformForCurrentView();
    }
    if (window.refreshVisualView)
    {
      // For split view, preserve the current pan/zoom. For visual view, allow reset.
      const preserveView = viewName === 'split';
      window.refreshVisualView(preserveView);
    }
  }
  else if (window.setVisualInputHighlightActive)
  {
    window.setVisualInputHighlightActive(false);
  }

  if ((viewName === 'visual' || viewName === 'split') && window.setVisualInputHighlightActive)
  {
    window.setVisualInputHighlightActive(true);
  }

  // If switching to controls view, initialize it
  if (viewName === 'controls')
  {
    if (window.initializeControlsEditor)
    {
      window.initializeControlsEditor();
    }
  }
}

// Make switchBindingsView globally available
window.switchBindingsView = switchBindingsView;


// ============================================================================
// SETTINGS PAGE AND SC DIRECTORY FUNCTIONS
// ============================================================================

function updateScDirectoryButtonIcon()
{
  const scDirectoryBtn = document.getElementById('sc-directory-btn');
  const scDirectoryIcon = document.getElementById('sc-directory-icon');
  const savedPath = localStorage.getItem('scInstallDirectory');
  if (scDirectoryIcon)
  {
    if (savedPath)
    {
      scDirectoryIcon.textContent = '⚙️';
      scDirectoryBtn.title = 'Configure auto-save deployment settings';
    } else
    {
      scDirectoryIcon.textContent = '⚠️';
      scDirectoryBtn.title = 'Auto-save not configured - click to set up';
    }
  }
}

function initializeSettingsPage()
{
  const resetCacheBtn = document.getElementById('reset-cache-btn');
  const manualUpdateCheckBtn = document.getElementById('manual-update-check-btn');
  const starfieldToggle = document.getElementById('starfield-toggle');
  const skipBindingRemovalCheckbox = document.getElementById('skip-binding-removal-confirmation');
  const chooseSCFolderBtn = document.getElementById('choose-sc-folder-btn');
  const scInstallPathDisplay = document.getElementById('sc-install-path-display');
  const scInstallationsList = document.getElementById('sc-installations-list');

  // SC Installation Directory picker
  if (chooseSCFolderBtn)
  {
    chooseSCFolderBtn.addEventListener('click', async () =>
    {
      try
      {
        const selectedPath = await open({
          directory: true,
          multiple: false,
          title: 'Select Star Citizen Installation Directory'
        });

        if (selectedPath)
        {
          scInstallPathDisplay.textContent = selectedPath;
          scInstallPathDisplay.classList.remove('empty');
          localStorage.setItem('scInstallDirectory', selectedPath);

          // Scan for installations
          await updateSCInstallationsList(selectedPath);

          // Update the button icon in keybindings toolbar
          updateScDirectoryButtonIcon();
        }
      } catch (error)
      {
        console.error('Error selecting SC folder:', error);
        await showAlert(`Error selecting folder: ${error}`, 'Error');
      }
    });
  }

  // Load saved SC directory on page load
  const savedSCPath = localStorage.getItem('scInstallDirectory');
  if (savedSCPath && scInstallPathDisplay)
  {
    scInstallPathDisplay.textContent = savedSCPath;
    scInstallPathDisplay.classList.remove('empty');
    updateSCInstallationsList(savedSCPath);
  }

  // Max joysticks setting
  const maxJoysticksSelect = document.getElementById('max-joysticks-select');
  if (maxJoysticksSelect)
  {
    // Load saved value
    const savedMaxJs = window.getMaxJoysticks ? window.getMaxJoysticks() : 4;
    maxJoysticksSelect.value = savedMaxJs.toString();

    maxJoysticksSelect.addEventListener('change', (e) =>
    {
      const value = parseInt(e.target.value, 10);
      if (window.setMaxJoysticks)
      {
        window.setMaxJoysticks(value);
      }
      // Re-render controls editor device tabs if it exists
      if (window.renderDeviceTabs)
      {
        window.renderDeviceTabs();
      }
      console.log('[SETTINGS] Max joysticks set to:', value);
    });
  }

  // Max gamepads setting
  const maxGamepadsSelect = document.getElementById('max-gamepads-select');
  if (maxGamepadsSelect)
  {
    // Load saved value
    const savedMaxGp = window.getMaxGamepads ? window.getMaxGamepads() : 4;
    maxGamepadsSelect.value = savedMaxGp.toString();

    maxGamepadsSelect.addEventListener('change', (e) =>
    {
      const value = parseInt(e.target.value, 10);
      if (window.setMaxGamepads)
      {
        window.setMaxGamepads(value);
      }
      // Re-render controls editor device tabs if it exists
      if (window.renderDeviceTabs)
      {
        window.renderDeviceTabs();
      }
      console.log('[SETTINGS] Max gamepads set to:', value);
    });
  }

  // Starfield visibility toggle
  if (starfieldToggle)
  {
    starfieldToggle.addEventListener('change', (e) =>
    {
      window.toggleStarfield(e.target.checked);
    });
  }

  // Keybinding removal confirmation toggle
  if (skipBindingRemovalCheckbox)
  {
    const savedSkipConfirm = localStorage.getItem('skipBindingRemovalConfirm') === 'true';
    skipBindingRemovalCheckbox.checked = savedSkipConfirm;

    skipBindingRemovalCheckbox.addEventListener('change', (e) =>
    {
      localStorage.setItem('skipBindingRemovalConfirm', e.target.checked);
    });
  }

  // Reset cache button
  if (resetCacheBtn)
  {
    resetCacheBtn.addEventListener('click', async () =>
    {
      const confirmed = await showConfirmation(
        'Are you sure you want to reset the application cache?',
        'Reset Application Cache',
        'Reset Cache',
        'Cancel',
        'btn-danger'
      );

      if (confirmed)
      {
        try
        {
          // Clear all localStorage
          localStorage.clear();
          await showAlert('Application cache has been reset. The app will now refresh.', 'Cache Reset');
          // Reload the page to apply the reset
          window.location.reload();
        } catch (error)
        {
          console.error('Error resetting cache:', error);
          await showAlert(`Error resetting cache: ${error}`, 'Error');
        }
      }
    });
  }

  // Manual update check button
  if (manualUpdateCheckBtn)
  {
    manualUpdateCheckBtn.addEventListener('click', async () =>
    {
      manualUpdateCheckBtn.disabled = true;
      try
      {
        if (window.manualUpdateCheck)
        {
          await window.manualUpdateCheck();
        }
      } catch (error)
      {
        console.error('Error during manual update check:', error);
      } finally
      {
        manualUpdateCheckBtn.disabled = false;
      }
    });
  }
}

async function updateSCInstallationsList(basePath)
{
  const scInstallationsList = document.getElementById('sc-installations-list');
  if (!scInstallationsList) return;

  try
  {
    scInstallationsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.9rem;">Scanning...</div>';

    const installations = await invoke('scan_sc_installations', { basePath });

    if (installations.length === 0)
    {
      scInstallationsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.9rem; font-style: italic;">No installations found</div>';
    } else
    {
      const installationsHTML = installations.map(inst => `
        <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; background: var(--bg-medium); border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 0.5rem;">
          <span style="font-size: 1.2rem;">🚀</span>
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #4ec9b0;">${inst.name}</div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); font-family: 'Consolas', 'Courier New', monospace;">${inst.path}</div>
          </div>
        </div>
      `).join('');
      scInstallationsList.innerHTML = installationsHTML;
    }
  } catch (error)
  {
    console.error('Error scanning SC installations:', error);
    scInstallationsList.innerHTML = `<div style="color: #ff6464; font-size: 0.9rem;">Error: ${error}</div>`;
  }
}

function switchTab(tabName)
{
  if (!tabName)
  {
    console.warn('switchTab called without a tab name');
    return;
  }

  currentTab = tabName;

  // Update active tab button
  document.querySelectorAll('.tab-btn').forEach(btn =>
  {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update active tab content
  document.querySelectorAll('.tab-content').forEach(content =>
  {
    content.classList.toggle('active', content.id === `tab-content-${tabName}`);
  });

  // Update body class for CSS selectors to show/hide template info
  document.body.classList.remove('tab-welcome', 'tab-bindings', 'tab-template', 'tab-debugger', 'tab-character', 'tab-help', 'tab-settings');
  document.body.classList.add(`tab-${tabName}`);

  // Save to localStorage
  localStorage.setItem('currentTab', tabName);

  // Handle tab-specific initialization
  if (tabName === 'bindings')
  {
    // Restore last used bindings view
    const savedBindingsView = localStorage.getItem('bindingsView') || 'list';
    switchBindingsView(savedBindingsView);
  }
  else if (tabName === 'template')
  {
    // Initialize template editor if needed
    if (window.initializeTemplateEditor)
    {
      window.initializeTemplateEditor();
    }
  }
  else if (tabName === 'character')
  {
    // Initialize character manager if needed
    if (window.initCharacterManager)
    {
      window.initCharacterManager();
    }
  }
  else if (tabName === 'debugger')
  {
    // Initialize device manager if needed
    if (window.initializeDeviceManager)
    {
      window.initializeDeviceManager();
    }
  }

  if (tabName !== 'bindings' && window.setVisualInputHighlightActive)
  {
    window.setVisualInputHighlightActive(false);
  }
}

function initializeHelpNavigation()
{
  const helpContainer = document.querySelector('#tab-content-help .help-page-container');
  if (!helpContainer) return;

  const helpLinks = helpContainer.querySelectorAll('.help-nav a[href^="#help-"]');
  helpLinks.forEach(link =>
  {
    link.addEventListener('click', (event) =>
    {
      const targetId = link.getAttribute('href')?.slice(1);
      if (!targetId) return;

      const target = document.getElementById(targetId);
      if (!target) return;

      event.preventDefault();

      const containerRect = helpContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const scrollTop = helpContainer.scrollTop + (targetRect.top - containerRect.top) - 16;

      helpContainer.scrollTo({
        top: Math.max(scrollTop, 0),
        behavior: 'smooth'
      });
    });
  });
}

const helpWizardIssues = [
  {
    id: 'app-js1-game-js2',
    question: 'My right joystick binds as js1 here, but Star Citizen calls it js2.',
    title: 'Make the app use the same joystick number as Star Citizen',
    paragraphs: [
      'Boxxy Binder and Star Citizen both use names like js1 and js2, but they may not always give those names to the same physical joystick.',
      'First, find out what Star Citizen calls each stick. Then tell Boxxy Binder to use those same names.'
    ],
    steps: [
      'Open Device Manager in Boxxy Binder.',
      'Find the right joystick and the left joystick.',
      'Change each Assigned Prefix so it matches what Star Citizen uses. For example, if Star Citizen says the right stick is js2, set the right stick to js2 here too.',
      'Go back to Keybindings and bind again.'
    ],
    actions: [{ label: 'Open Device Manager', tab: 'debugger' }]
  },
  {
    id: 'wrong-stick-action',
    question: 'When I press my right trigger, the left trigger action happens.',
    title: 'Check whether the device numbers are flipped inside the binding file',
    paragraphs: [
      'This usually means one of two things: either the app is using the wrong js number for a joystick, or the loaded keybinding file has the two joystick numbers swapped.',
      'Do the simple check first: make sure Boxxy Binder and Star Citizen agree on which stick is js1 and which stick is js2.'
    ],
    steps: [
      'In Star Citizen, bind any test action to the right joystick trigger and look at the js number it shows.',
      'In Boxxy Binder, open Device Manager and check that the right joystick has that same Assigned Prefix.',
      'If the app and game match, but the actions are still flipped, go to Keybindings.',
      'Click Swap Device Prefixes, swap the two joystick prefixes, then save the keybinding file.',
      'Reload the bindings in Star Citizen with the console command, or restart the game.'
    ],
    actions: [
      { label: 'Open Device Manager', tab: 'debugger' },
      { label: 'Open Keybindings', tab: 'bindings', view: 'list' }
    ]
  },
  {
    id: 'saved-not-working',
    question: 'I saved my keybindings, but the changes are not working in Star Citizen.',
    title: 'Reload the saved file inside Star Citizen',
    paragraphs: [
      'Saving in Boxxy Binder updates the file on disk. Star Citizen does not automatically re-read that file while it is running.',
      'Think of Star Citizen as holding its own active copy of your controls. After saving, you still need to tell the game to load the updated file.'
    ],
    steps: [
      'Save your keybindings in Boxxy Binder.',
      'Use the Copy Command button on the Keybindings page if it is available.',
      'In Star Citizen, open the console with the tilde key (~).',
      'Paste the command and press Enter. You can also restart Star Citizen instead.'
    ],
    actions: [{ label: 'Open Keybindings', tab: 'bindings', view: 'list' }]
  },
  {
    id: 'device-supported',
    question: 'Is my device supported?',
    title: 'Most USB HID devices should work',
    paragraphs: [
      'Most likely, yes. Boxxy Binder listens for USB devices using standard HID information, which is the common way many joysticks, gamepads, pedals, and button boxes report their inputs.',
      'That said, some manufacturers report buttons or axes in unusual ways. Those devices may need extra mapping, and perfect support cannot be guaranteed for every device.'
    ],
    steps: [
      'Open Device Manager and press buttons or move axes on the device.',
      'If the app sees the inputs, you should be able to bind them.',
      'If something looks wrong, use Device Manager to check or adjust the detected inputs.'
    ],
    actions: [{ label: 'Open Device Manager', tab: 'debugger' }]
  },
  {
    id: 'template-required',
    question: 'I do not understand templates. Are templates required?',
    title: 'Templates are only needed for the visual view',
    paragraphs: [
      'A template is a visual map of your devices. It says which devices you use, shows an image for each one, and places button frames on top so the visual view can show what each button does.',
      'Templates are optional. Without a template, you can still use the Keybindings list to bind inputs to actions. You just will not get the nice visual layout for that device.'
    ],
    steps: [
      'Use Keybindings if you only want to edit controls in a list.',
      'Create or import a template if you want to see your device image and click visual button frames.',
      'Set each template device prefix to match the same js number Star Citizen uses.'
    ],
    actions: [
      { label: 'Open Template Editor', tab: 'template' },
      { label: 'Open Keybindings', tab: 'bindings', view: 'list' }
    ]
  },
  {
    id: 'multi-device-templates',
    question: 'Why can templates have more than one device?',
    title: 'Templates can group devices however you like',
    paragraphs: [
      'A template can be one device, or it can be a whole setup. Both are valid.',
      'For example, you might use one downloaded template for two VKB sticks, then make a separate template for Virpil pedals. In the visual view, you can load both. Or you can build one big template that contains all three devices from scratch.'
    ],
    steps: [
      'Use one template per device if you want small reusable pieces.',
      'Use one template for your whole setup if you prefer everything in one file.',
      'Load multiple templates in the visual view when you want to stack separate templates together.'
    ],
    actions: [{ label: 'Open Template Editor', tab: 'template' }]
  }
];

function initializeHelpWizard()
{
  const openButton = document.getElementById('open-help-wizard-btn');
  const modal = document.getElementById('help-wizard-modal');
  const closeButton = document.getElementById('help-wizard-close-btn');
  const doneButton = document.getElementById('help-wizard-done-btn');
  const issueList = document.getElementById('help-wizard-issue-list');

  if (!openButton || !modal || !closeButton || !doneButton || !issueList) return;

  let selectedIssueId = helpWizardIssues[0]?.id || null;

  const renderSelectedIssue = () =>
  {
    const selectedIssue = helpWizardIssues.find(issue => issue.id === selectedIssueId) || helpWizardIssues[0];
    if (!selectedIssue) return;

    document.querySelectorAll('.help-wizard-issue-btn').forEach(button =>
    {
      const isSelected = button.dataset.issueId === selectedIssue.id;
      button.classList.toggle('active', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });

    const answerTitle = document.getElementById('help-wizard-answer-title');
    const answerBody = document.getElementById('help-wizard-answer-body');
    const answerActions = document.getElementById('help-wizard-answer-actions');
    if (!answerTitle || !answerBody || !answerActions) return;

    answerTitle.textContent = selectedIssue.title;
    answerBody.innerHTML = '';
    answerActions.innerHTML = '';

    selectedIssue.paragraphs.forEach(text =>
    {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      answerBody.appendChild(paragraph);
    });

    const list = document.createElement('ol');
    selectedIssue.steps.forEach(text =>
    {
      const item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    });
    answerBody.appendChild(list);

    selectedIssue.actions.forEach(action =>
    {
      const button = document.createElement('button');
      button.className = 'btn btn-primary btn-sm';
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () =>
      {
        closeHelpWizard();
        switchTab(action.tab);

        if (action.view)
        {
          switchBindingsView(action.view);
        }
      });
      answerActions.appendChild(button);
    });
  };

  helpWizardIssues.forEach(issue =>
  {
    const button = document.createElement('button');
    button.className = 'help-wizard-issue-btn';
    button.type = 'button';
    button.dataset.issueId = issue.id;
    button.textContent = issue.question;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () =>
    {
      selectedIssueId = issue.id;
      renderSelectedIssue();
    });
    issueList.appendChild(button);
  });

  const handleEscape = (event) =>
  {
    if (event.key === 'Escape')
    {
      closeHelpWizard();
    }
  };

  function openHelpWizard()
  {
    modal.style.display = 'flex';
    renderSelectedIssue();
    document.addEventListener('keydown', handleEscape);
    setTimeout(() => closeButton.focus(), 100);
  }

  function closeHelpWizard()
  {
    modal.style.display = 'none';
    document.removeEventListener('keydown', handleEscape);
  }

  openButton.addEventListener('click', openHelpWizard);
  closeButton.addEventListener('click', closeHelpWizard);
  doneButton.addEventListener('click', closeHelpWizard);
  modal.addEventListener('click', (event) =>
  {
    if (event.target === modal)
    {
      closeHelpWizard();
    }
  });
}

function initializeEventListeners()
{
  // Version number click to show What's New
  const versionEl = document.getElementById('app-version');
  if (versionEl)
  {
    versionEl.style.cursor = 'pointer';
    versionEl.title = 'Click to see what\'s new';
    versionEl.addEventListener('click', showWhatsNewModal);
  }

  // Load button
  const loadBtn = document.getElementById('load-btn');
  const welcomeLoadBtn = document.getElementById('welcome-load-btn');
  if (loadBtn) loadBtn.addEventListener('click', () => { if (window.loadKeybindingsFile) window.loadKeybindingsFile(); });
  if (welcomeLoadBtn) welcomeLoadBtn.addEventListener('click', () => { if (window.loadKeybindingsFile) window.loadKeybindingsFile(); });

  // Welcome screen "Create New Set" button
  const welcomeNewBtn = document.getElementById('welcome-new-btn');
  if (welcomeNewBtn) welcomeNewBtn.addEventListener('click', () => { if (window.newKeybinding) window.newKeybinding(); });

  // Save buttons
  const saveBtn = document.getElementById('save-btn');
  const saveAsBtn = document.getElementById('save-as-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => { if (window.saveKeybindings) window.saveKeybindings(); });
  if (saveAsBtn) saveAsBtn.addEventListener('click', () => { if (window.saveKeybindingsAs) window.saveKeybindingsAs(); });

  // SC Directory / Auto-Save Settings button
  const scDirectoryBtn = document.getElementById('sc-directory-btn');
  const scDirectoryIcon = document.getElementById('sc-directory-icon');

  if (scDirectoryBtn) scDirectoryBtn.addEventListener('click', async () =>
  {
    await openAutoSaveModal();
  });

  // Update icon on page load
  updateScDirectoryButtonIcon();

  // Listen for storage changes to update icon if it changes in another tab
  window.addEventListener('storage', (e) =>
  {
    if (e.key === 'scInstallDirectory')
    {
      updateScDirectoryButtonIcon();
    }
  });

  // Update icon when page becomes visible (user returns from settings page)
  document.addEventListener('visibilitychange', () =>
  {
    if (!document.hidden)
    {
      updateScDirectoryButtonIcon();
    }
  });

  // Ko-fi header button
  const kofiBtn = document.getElementById('kofi-header-btn');
  if (kofiBtn) kofiBtn.addEventListener('click', () =>
  {
    // Switch to welcome tab
    switchTab('welcome');
    // Scroll to the support section
    setTimeout(() =>
    {
      const supportSection = document.querySelector('.support-section');
      if (supportSection)
      {
        supportSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  });

  // HID debugger view switcher
  const switchToHIDDebug = document.getElementById('switch-to-hid-debug');
  if (switchToHIDDebug)
  {
    switchToHIDDebug.addEventListener('click', () =>
    {
      // Navigate to HID debugger page
      window.location.href = 'hid-debugger.html';
    });
  }

  // Filter buttons
  const filterBtns = document.querySelectorAll('.filter-section .category-item');
  if (filterBtns.length > 0)
  {
    filterBtns.forEach(btn =>
    {
      btn.addEventListener('click', (e) =>
      {
        filterBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        if (window.setCurrentFilter) window.setCurrentFilter(e.target.dataset.filter);
        if (window.renderKeybindings) window.renderKeybindings();
      });
    });
  }

  // Search input
  const searchInput = document.getElementById('search-input');
  const searchClearBtn = document.getElementById('search-clear-btn');

  if (searchInput)
  {
    searchInput.addEventListener('input', (e) =>
    {
      if (window.setSearchTerm) window.setSearchTerm(e.target.value.toLowerCase());
      // Show/hide clear button based on input value
      if (searchClearBtn)
      {
        searchClearBtn.style.display = e.target.value ? 'flex' : 'none';
      }
      if (window.renderKeybindings) window.renderKeybindings();
    });
  }

  if (searchClearBtn)
  {
    searchClearBtn.addEventListener('click', () =>
    {
      searchInput.value = '';
      if (window.setSearchTerm) window.setSearchTerm('');
      searchClearBtn.style.display = 'none';
      if (window.renderKeybindings) window.renderKeybindings();
    });
  }

  // Copy command button
  const copyCommandBtn = document.getElementById('copy-command-btn');
  if (copyCommandBtn)
  {
    copyCommandBtn.addEventListener('click', async () =>
    {
      const filename = window.getCurrentFilename ? window.getCurrentFilename() : null;
      if (!filename) return;

      const command = `pp_RebindKeys ${filename}`;

      try
      {
        // Copy to clipboard
        await navigator.clipboard.writeText(command);

        // Show toast notification
        if (window.toast)
        {
          window.toast.success(`Command copied: ${command}`);
        } else
        {
          // Fallback: Show temporary success message on button
          const originalText = copyCommandBtn.textContent;
          copyCommandBtn.textContent = '✓ Copied!';
          copyCommandBtn.style.opacity = '0.8';

          setTimeout(() =>
          {
            copyCommandBtn.textContent = originalText;
            copyCommandBtn.style.opacity = '1';
          }, 2000);
        }

        // Log the command for user convenience
        console.log('Command copied to clipboard:', command);
      } catch (error)
      {
        console.error('Failed to copy to clipboard:', error);
        if (window.toast)
        {
          window.toast.error('Failed to copy to clipboard');
        }
      }
    });
  }
  const customizedCheckbox = document.getElementById('customized-only-checkbox');
  if (customizedCheckbox)
  {
    customizedCheckbox.addEventListener('change', (e) =>
    {
      if (window.setCustomizedOnly) window.setCustomizedOnly(e.target.checked);
      if (window.renderKeybindings) window.renderKeybindings();
    });
  }

  const showUnboundCheckbox = document.getElementById('show-unbound-checkbox');
  if (showUnboundCheckbox)
  {
    showUnboundCheckbox.checked = window.getShowUnboundActions ? window.getShowUnboundActions() : true;
    showUnboundCheckbox.addEventListener('change', (e) =>
    {
      if (window.setShowUnboundActions) window.setShowUnboundActions(e.target.checked);
      if (window.renderKeybindings) window.renderKeybindings();
    });
  }

  // Binding modal buttons
  const bindingCancelBtn = document.getElementById('binding-cancel-btn');
  const bindingModalSaveBtn = document.getElementById('binding-modal-save-btn');
  if (bindingCancelBtn) bindingCancelBtn.addEventListener('click', () => { if (window.cancelBinding) window.cancelBinding(); });
  if (bindingModalSaveBtn)
  {
    bindingModalSaveBtn.addEventListener('click', async () =>
    {
      if (!window.pendingBinding) return;

      const { actionMapName, actionName, mappedInput, multiTap } = window.pendingBinding;

      // Get the selected activation mode
      const activationModeSelect = document.getElementById('activation-mode-select');
      const activationMode = activationModeSelect ? activationModeSelect.value : null;

      window.stopDetection('user-save-modal');
      if (window.applyBinding) await window.applyBinding(actionMapName, actionName, mappedInput, multiTap, activationMode);
      window.pendingBinding = null;
      if (window.setBindingSaveEnabled) window.setBindingSaveEnabled(false);
    });
    if (window.setBindingSaveEnabled) window.setBindingSaveEnabled(false);
  }

  const setIgnoreModalMouse = (value) =>
  {
    window.setIgnoreModalMouseInputs(value);
  };

  const attachHoverGuard = (element) =>
  {
    if (!element) return;
    element.addEventListener('pointerenter', () => setIgnoreModalMouse(true));
    element.addEventListener('pointerleave', () => setIgnoreModalMouse(false));
    element.addEventListener('pointerdown', () => setIgnoreModalMouse(true));
    element.addEventListener('pointerup', () => setIgnoreModalMouse(false));
  };

  attachHoverGuard(bindingCancelBtn);
  attachHoverGuard(bindingModalSaveBtn);

  // Conflict modal buttons
  const conflictCancelBtn = document.getElementById('conflict-cancel-btn');
  const conflictConfirmBtn = document.getElementById('conflict-confirm-btn');
  if (conflictCancelBtn) conflictCancelBtn.addEventListener('click', closeConflictModal);
  if (conflictConfirmBtn) conflictConfirmBtn.addEventListener('click', confirmConflictBinding);

  // Joystick mapping button - now switches to Device Manager tab
  const configureBtn = document.getElementById('configure-joystick-mapping-btn');
  if (configureBtn) configureBtn.addEventListener('click', () => switchTab('debugger'));

  // New Keybinding button
  const newKeybindingBtn = document.getElementById('new-keybinding-btn');
  if (newKeybindingBtn) newKeybindingBtn.addEventListener('click', newKeybinding);

  // Clear SC Binds button
  const clearSCBindsBtn = document.getElementById('clear-sc-binds-btn');
  if (clearSCBindsBtn) clearSCBindsBtn.addEventListener('click', openClearSCBindsModal);

  // Swap Joystick Prefixes button
  const swapJoystickPrefixesBtn = document.getElementById('swap-joystick-prefixes-btn');
  if (swapJoystickPrefixesBtn) swapJoystickPrefixesBtn.addEventListener('click', () => window.swapJoystickPrefixes && window.swapJoystickPrefixes());

  // Clear SC Binds modal buttons
  const clearBindsGenerateBtn = document.getElementById('clear-binds-generate-btn');
  const copyUnbindCommandBtn = document.getElementById('copy-unbind-command-btn');
  const removeUnbindFilesBtn = document.getElementById('remove-unbind-files-btn');
  if (clearBindsGenerateBtn) clearBindsGenerateBtn.addEventListener('click', generateUnbindProfile);
  if (copyUnbindCommandBtn) copyUnbindCommandBtn.addEventListener('click', copyUnbindCommand);
  if (removeUnbindFilesBtn) removeUnbindFilesBtn.addEventListener('click', removeUnbindFiles);

  // Restore Defaults button
  const restoreDefaultsBtn = document.getElementById('restore-defaults-btn');
  if (restoreDefaultsBtn) restoreDefaultsBtn.addEventListener('click', openRestoreDefaultsModal);

  // Restore Defaults modal buttons
  const restoreDefaultsGenerateBtn = document.getElementById('restore-defaults-generate-btn');
  const copyRestoreDefaultsCommandBtn = document.getElementById('copy-restore-defaults-command-btn');
  const removeRestoreDefaultsFilesBtn = document.getElementById('remove-restore-defaults-files-btn');
  if (restoreDefaultsGenerateBtn) restoreDefaultsGenerateBtn.addEventListener('click', generateRestoreDefaultsProfile);
  if (copyRestoreDefaultsCommandBtn) copyRestoreDefaultsCommandBtn.addEventListener('click', copyRestoreDefaultsCommand);
  if (removeRestoreDefaultsFilesBtn) removeRestoreDefaultsFilesBtn.addEventListener('click', removeRestoreDefaultsFiles);

  // Auto-Save modal buttons
  const autoSaveModalCloseBtn = document.getElementById('auto-save-modal-close-btn');
  const autoSaveGotoSettingsBtn = document.getElementById('auto-save-goto-settings-btn');
  const autoSaveAllCheckbox = document.getElementById('auto-save-all-checkbox');

  if (autoSaveModalCloseBtn)
  {
    autoSaveModalCloseBtn.addEventListener('click', closeAutoSaveModal);
  }

  if (autoSaveGotoSettingsBtn)
  {
    autoSaveGotoSettingsBtn.addEventListener('click', () =>
    {
      closeAutoSaveModal();
      switchTab('settings');
    });
  }

  if (autoSaveAllCheckbox)
  {
    autoSaveAllCheckbox.addEventListener('change', (e) =>
    {
      localStorage.setItem('autoSaveToAllInstallations', e.target.checked.toString());
      console.log('Auto-save to all installations:', e.target.checked);
    });
  }
}









// Legacy function - kept for backward compatibility but no longer updates header
function updateTemplateIndicator(templateName, fileName = null)
{
  // Template indicators are now in toolbars, not in header
  // This function is kept for backward compatibility
  if (templateName)
  {
    localStorage.setItem('currentTemplateName', templateName);
  }
}

// Legacy function - kept for backward compatibility but no longer updates header
function updateViewerTemplateIndicator(templateName, fileName = null)
{
  // Template indicators are now in toolbars, not in header
  // This function is kept for backward compatibility
  if (templateName)
  {
    localStorage.setItem('viewerCurrentTemplateName', templateName);
  }
}

// Make functions globally available for backward compatibility
window.updateTemplateIndicator = updateTemplateIndicator;
window.updateViewerTemplateIndicator = updateViewerTemplateIndicator;

// Helper to call updateTemplateIndicator safely (waits if not yet defined)
window.safeUpdateTemplateIndicator = function (name)
{
  if (window.updateTemplateIndicator)
  {
    window.updateTemplateIndicator(name);
  } else
  {
    // If the function isn't ready yet, store in localStorage and it will be called on DOMContentLoaded
    localStorage.setItem('pendingTemplateName', name);
  }
}

// Search for a button ID in the main keybindings view
window.searchMainTabForButtonId = function (buttonId)
{
  const bindingsTabContent = document.getElementById('tab-content-bindings');
  const isSplitModeActive = !!bindingsTabContent?.classList.contains('split-mode');
  const isCurrentlyBindingsTab = document.body.classList.contains('tab-bindings');
  const splitBtnActive = !!document.querySelector('.bindings-view-btn[data-view="split"].active');

  const shouldUseSplitView = isSplitModeActive || splitBtnActive || (isCurrentlyBindingsTab && localStorage.getItem('bindingsView') === 'split');
  const desiredView = shouldUseSplitView ? 'split' : 'list';

  // Ensure the saved view stays consistent before we switch tabs
  localStorage.setItem('bindingsView', desiredView);

  // Switch to the bindings tab
  switchTab('bindings');

  // Force the desired view after switching tabs
  switchBindingsView(desiredView);

  // Get the search input element
  const searchInput = document.getElementById('search-input');
  if (searchInput)
  {
    // Set the search input value
    searchInput.value = buttonId;

    // Trigger the search by firing an input event
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Scroll the search input into view
    searchInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Focus the search input
    searchInput.focus();
  }
};


// Make switchTab globally available for other modules
window.switchTab = switchTab;












// Global function to clear all bindings for an action (called from action-level Clear button)
window.clearActionBinding = async function (actionMapName, actionName)
{
  console.log('clearActionBinding called with:', { actionMapName, actionName });

  // Show custom confirmation dialog
  const confirmed = await showConfirmation(
    'Clear all bindings for this action?',
    'Clear Action Bindings',
    'Clear',
    'Cancel'
  );

  if (!confirmed)
  {
    console.log('User cancelled action clearing');
    return;
  }

  try
  {
    // Find the action to see what default bindings it has
    const action = window.getCurrentKeybindings().action_maps
      .find(am => am.name === actionMapName)
      ?.actions.find(a => a.name === actionName);

    if (!action)
    {
      console.error('Action not found');
      return;
    }

    // Get all the current bindings (including defaults) to determine which input types to clear
    const inputTypesToClear = new Set();
    if (action.bindings)
    {
      action.bindings.forEach(binding =>
      {
        if (binding.input && binding.input.trim())
        {
          // Determine input type from the binding
          if (binding.input.startsWith('js'))
          {
            inputTypesToClear.add('joystick');
          }
          else if (binding.input.startsWith('kb'))
          {
            inputTypesToClear.add('keyboard');
          }
          else if (binding.input.startsWith('mouse'))
          {
            inputTypesToClear.add('mouse');
          }
          else if (binding.input.startsWith('gp'))
          {
            inputTypesToClear.add('gamepad');
          }
        }
      });
    }

    console.log('Input types to clear:', Array.from(inputTypesToClear));

    // Clear each input type by providing the appropriate cleared binding format
    for (const inputType of inputTypesToClear)
    {
      let clearedInput = '';
      switch (inputType)
      {
        case 'joystick':
          clearedInput = 'js1_ '; // Cleared joystick binding
          break;
        case 'keyboard':
          clearedInput = 'kb1_ '; // Cleared keyboard binding
          break;
        case 'mouse':
          clearedInput = 'mouse1_ '; // Cleared mouse binding
          break;
        case 'gamepad':
          clearedInput = 'gp1_ '; // Cleared gamepad binding
          break;
      }

      if (clearedInput)
      {
        console.log(`Clearing ${inputType} with: "${clearedInput}"`);
        await invoke('update_binding', {
          actionMapName: actionMapName,
          actionName: actionName,
          newInput: clearedInput
        });
      }
    }

    // Mark as unsaved
    window.setHasUnsavedChanges(true);
    updateUnsavedIndicator();

    await window.refreshBindings();

    // Refresh visual view if in split view or visual view mode
    const currentBindingsView = localStorage.getItem('bindingsView') || 'list';
    if ((currentBindingsView === 'split' || currentBindingsView === 'visual') && window.refreshVisualView)
    {
      await window.refreshVisualView(true); // true = preserve pan/zoom
    }
  } catch (error)
  {
    console.error('Error clearing action binding:', error);
    await showAlert(`Error clearing action binding: ${error}`, 'Error');
  }
};

// Global function to reset an action to default bindings (called from action-level Reset button)
window.resetActionBinding = async function (actionMapName, actionName)
{
  console.log('resetActionBinding called with:', { actionMapName, actionName });

  // Show custom confirmation dialog
  const confirmed = await showConfirmation(
    'Reset this action to default bindings?',
    'Reset to Default',
    'Reset',
    'Cancel'
  );

  if (!confirmed)
  {
    console.log('User cancelled action reset');
    return;
  }

  try
  {
    // Call backend to reset binding (remove customization)
    await invoke('reset_binding', {
      actionMapName: actionMapName,
      actionName: actionName
    });

    // Mark as unsaved
    window.setHasUnsavedChanges(true);
    updateUnsavedIndicator();

    // Refresh to show default bindings
    await window.refreshBindings();
    window.closeBindingModal();
  } catch (error)
  {
    console.error('Error resetting action binding:', error);
    // Fallback to old method if reset_binding doesn't exist
    if (error.toString().includes('not found'))
    {
      console.log('Using fallback reset method');
      try
      {
        await invoke('update_binding', {
          actionMapName: actionMapName,
          actionName: actionName,
          newInput: ''
        });
        window.setHasUnsavedChanges(true);
        updateUnsavedIndicator();
        await window.refreshBindings();
      } catch (fallbackError)
      {
        console.error('Error in fallback reset:', fallbackError);
        await showAlert(`Error resetting binding: ${fallbackError}`, 'Error');
      }
    } else
    {
      await showAlert(`Error resetting binding: ${error}`, 'Error');
    }
  }
};

// Function to remove a specific binding
window.removeBinding = async function (actionMapName, actionName, inputToClear)
{
  console.log('removeBinding called with:', { actionMapName, actionName, inputToClear });

  const skipConfirmation = localStorage.getItem('skipBindingRemovalConfirm') === 'true';
  if (!skipConfirmation)
  {
    // Show custom confirmation dialog BEFORE doing anything
    const confirmed = await showConfirmation(
      'Clear this binding?',
      'Clear Binding',
      'Clear',
      'Cancel',
      'btn-danger'
    );

    // If user cancelled, stop immediately
    if (!confirmed)
    {
      console.log('User cancelled binding removal');
      return false;
    }
  }

  console.log('User confirmed, proceeding with removal');

  try
  {
    // Call backend to remove the specific input binding
    // This sets the binding to a cleared state (e.g., "js1_ " with trailing space)
    await invoke('clear_specific_binding', {
      actionMapName: actionMapName,
      actionName: actionName,
      inputToClear: inputToClear
    });

    // Mark as unsaved
    window.setHasUnsavedChanges(true);
    updateUnsavedIndicator();

    // Refresh bindings
    await window.refreshBindings();

    // Refresh visual view if in split view or visual view mode
    const currentBindingsView = localStorage.getItem('bindingsView') || 'list';
    if ((currentBindingsView === 'split' || currentBindingsView === 'visual') && window.refreshVisualView)
    {
      await window.refreshVisualView(true); // true = preserve pan/zoom
    }

    return true;
  } catch (error)
  {
    console.error('Error removing binding:', error);
    await showAlert(`Error removing binding: ${error}`, 'Error');
    return false;
  }
};

function updateUnsavedIndicator()
{
  const indicator = document.getElementById('loaded-file-indicator');
  const fileNameEl = document.getElementById('loaded-file-name');
  const indicatorSub = document.getElementById('loaded-file-indicator-sub');
  const fileNameSubEl = document.getElementById('loaded-file-name-sub');

  if (indicator && fileNameEl)
  {
    if (window.getHasUnsavedChanges())
    {
      indicator.classList.add('unsaved');
      if (!fileNameEl.textContent.includes('*'))
      {
        fileNameEl.textContent += ' *';
      }
    }
    else
    {
      indicator.classList.remove('unsaved');
      fileNameEl.textContent = fileNameEl.textContent.replace(' *', '');
    }
  }

  // Update sub-nav indicator as well
  if (indicatorSub && fileNameSubEl)
  {
    if (window.getHasUnsavedChanges())
    {
      indicatorSub.classList.add('unsaved');
      if (!fileNameSubEl.textContent.includes('*'))
      {
        fileNameSubEl.textContent += ' *';
      }
    }
    else
    {
      indicatorSub.classList.remove('unsaved');
      fileNameSubEl.textContent = fileNameSubEl.textContent.replace(' *', '');
    }
  }
}

// Make globally available
window.updateUnsavedIndicator = updateUnsavedIndicator;




















// =====================
// INITIALIZE VERSION ON STARTUP
// =====================
(async () =>
{
  try
  {
    const version = await invoke('get_app_version');
    const versionElement = document.getElementById('app-version');
    if (versionElement)
    {

      // If the version starts with "0.", it's a beta build - append " (Beta)"
      if (version.startsWith('0.'))
      {
        versionElement.textContent = `v${version} (Beta)`;
      } else

        versionElement.textContent = `v${version}`;
    }
  } catch (error)
  {
    console.error('Failed to load app version:', error);
  }
})();

// =====================
// INITIALIZE SETTINGS LOG SECTION
// =====================
(async () =>
{
  try
  {
    const logPath = await invoke('get_log_file_path');
    const logPathDisplay = document.getElementById('log-path-display');
    const copyLogPathBtn = document.getElementById('copy-log-path-btn');

    if (!logPathDisplay || !copyLogPathBtn)
    {
      return;
    }

    logPathDisplay.textContent = logPath;
    logPathDisplay.title = `Log file: ${logPath}`;
    copyLogPathBtn.addEventListener('click', async () =>
    {
      try
      {
        await navigator.clipboard.writeText(logPath);
        if (window.toast)
        {
          window.toast.success('Log path copied to clipboard');
        } else
        {
          await showAlert(`Log file path:\n${logPath}`, 'Log File Path');
        }
      } catch (error)
      {
        console.error('Failed to copy to clipboard:', error);
        await showAlert(`Log file path:\n${logPath}`, 'Log File Path');
      }
    });
  } catch (error)
  {
    console.error('Failed to initialize settings log section:', error);

    const logPathDisplay = document.getElementById('log-path-display');
    const copyLogPathBtn = document.getElementById('copy-log-path-btn');
    if (logPathDisplay)
    {
      logPathDisplay.textContent = 'Unable to load log path';
    }
    if (copyLogPathBtn)
    {
      copyLogPathBtn.disabled = true;
    }
  }
})();

// =====================
// FONT SIZE SCALING (Ctrl +/- / Cmd +/-)
// =====================

const FONT_SIZE_MIN = 10; // pixels
const FONT_SIZE_MAX = 24; // pixels
const FONT_SIZE_DEFAULT = 14; // pixels
const FONT_SIZE_STEP = 1; // pixels per increment

function initializeFontSizeScaling()
{
  // Load saved font size or use default
  const savedFontSize = localStorage.getItem('appFontSize');
  if (savedFontSize)
  {
    setFontSize(parseInt(savedFontSize));
  } else
  {
    setFontSize(FONT_SIZE_DEFAULT);
  }

  // Add keyboard listener for font size controls
  document.addEventListener('keydown', (e) =>
  {
    // Check for Ctrl (Windows/Linux) or Cmd (Mac)
    const isModifierPressed = e.ctrlKey || e.metaKey;

    if (isModifierPressed && !e.altKey && !e.shiftKey)
    {
      if (e.key === '+' || e.key === '=')
      {
        e.preventDefault();
        increaseFontSize();
      } else if (e.key === '-' || e.key === '_')
      {
        e.preventDefault();
        decreaseFontSize();
      } else if (e.key === '0')
      {
        e.preventDefault();
        resetFontSize();
      }
    }
  });

  // Prevent Alt+Space from opening the system menu (hidden File/Edit menu)
  // This intercepts the Alt key to stop the browser/webview default behavior
  document.addEventListener('keydown', (e) =>
  {
    // Block Alt+Space specifically (system menu shortcut)
    if (e.altKey && e.code === 'Space')
    {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    // Also block plain Alt key from activating the menu bar
    // Only when a modal is open or during binding detection
    if (e.key === 'Alt' && (window.isBindingModalOpen?.() || window.getIsDetectionActive?.()))
    {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true); // Use capture phase to intercept before default handlers
}

function setFontSize(size)
{
  // Clamp size between min and max
  size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));

  // Apply to root element
  document.documentElement.style.fontSize = `${size}px`;

  // Save to localStorage
  localStorage.setItem('appFontSize', size);

  console.log(`Font size set to ${size}px`);
}

function increaseFontSize()
{
  const current = parseInt(localStorage.getItem('appFontSize') || FONT_SIZE_DEFAULT);
  setFontSize(current + FONT_SIZE_STEP);
}

function decreaseFontSize()
{
  const current = parseInt(localStorage.getItem('appFontSize') || FONT_SIZE_DEFAULT);
  setFontSize(current - FONT_SIZE_STEP);
}

function resetFontSize()
{
  setFontSize(FONT_SIZE_DEFAULT);
}

// Make font size controls globally available
window.increaseFontSize = increaseFontSize;
window.decreaseFontSize = decreaseFontSize;
window.resetFontSize = resetFontSize;

// =====================
// ACTION BINDINGS MANAGER MODAL
// =====================

let currentActionBindingsData = null;
let pendingActionBindingsReturn = null;

async function openActionBindingsModal(actionMapName, actionName, actionDisplayName)
{
  currentActionBindingsData = {
    actionMapName,
    actionName,
    actionDisplayName
  };

  // Get the action data
  const actionMap = window.getCurrentKeybindings().action_maps.find(am => am.name === actionMapName);
  if (!actionMap) return;

  const action = actionMap.actions.find(a => a.name === actionName);
  if (!action) return;

  // Show modal
  const modal = document.getElementById('action-bindings-modal');
  const title = document.getElementById('action-bindings-title');
  const listContainer = document.getElementById('action-bindings-list');

  title.textContent = `${actionDisplayName}`;

  // Render bindings list
  let html = '';

  // Check if this action only has the special "unbound" placeholder
  const hasOnlyUnboundPlaceholder = action.bindings && action.bindings.length === 1 &&
    action.bindings[0].input.match(/^(js\d*|kb\d*|mouse\d*|gp\d*)_\s*$/) &&
    action.bindings[0].is_default &&
    action.bindings[0].display_name === 'Unbound';

  if (!action.bindings || action.bindings.length === 0 || hasOnlyUnboundPlaceholder)
  {
    html = '<div class="empty-state" style="padding: 2rem; text-align: center; color: var(--text-secondary);">No bindings for this action. Click "Add New Binding" to create one.</div>';
  }
  else
  {
    action.bindings.forEach((binding, index) =>
    {
      const trimmedInput = binding.input.trim();

      // Skip truly empty bindings
      if (!trimmedInput || trimmedInput === '') return;

      // Check if this is a cleared binding (e.g., "js1_ ", "kb1_ ", etc.)
      const isClearedBinding = binding.input.match(/^(js\d*|kb\d*|mouse\d*|gp\d*)_\s*$/);

      // Skip cleared bindings - they shouldn't show in the modal
      if (isClearedBinding) return;

      let icon = '○';
      if (binding.input_type === 'Keyboard') icon = '⌨️';
      else if (binding.input_type === 'Mouse') icon = '🖱️';
      else if (binding.input_type === 'Joystick') icon = '🕹️';
      else if (binding.input_type === 'Gamepad') icon = '🎮';

      const defaultBadge = binding.is_default ? '<span class="action-binding-default-badge">Default</span>' : '';
      const customBadge = !binding.is_default ? '<span class="action-binding-custom-badge">Custom</span>' : '';
      const clearedBadge = isClearedBinding ? '<span class="action-binding-cleared-badge">Cleared</span>' : '';
      const activationValue = binding.activation_mode || '';

      // Disable remove button for unbound bindings
      const isUnbound = binding.input_type === 'Unknown';
      const removeButtonDisabled = isUnbound ? 'disabled' : '';

      // Try to get button name from template
      let buttonNameSuffix = '';
      if (window.findButtonNameForInput && !isClearedBinding && binding.input_type === 'Joystick')
      {
        const buttonName = window.findButtonNameForInput(binding.input);
        if (buttonName)
        {
          buttonNameSuffix = ` <span style="color: #aaa; font-size: 0.9em;">[${buttonName}]</span>`;
        }
      }

      html += `
        <div class="action-binding-item ${binding.is_default ? 'is-default' : ''} ${isClearedBinding ? 'is-cleared' : ''}" data-binding-index="${index}">
          <div class="action-binding-icon">${icon}</div>
          <div class="action-binding-device">
            ${binding.input_type}${defaultBadge}${customBadge}${clearedBadge}
          </div>
          <div class="action-binding-input ${isClearedBinding ? 'cleared-text' : ''}">${isClearedBinding && binding.original_default ? `<span style="text-decoration: line-through;">${binding.original_default}</span>` : binding.display_name}${buttonNameSuffix}</div>
          <div class="action-binding-activation">
            <select class="binding-activation-select" data-binding-index="${index}" ${isClearedBinding ? 'disabled' : ''}>
              <option value="">Default (Press)</option>
              <option value="press" ${activationValue === 'press' ? 'selected' : ''}>Press</option>
              <option value="press_quicker" ${activationValue === 'press_quicker' ? 'selected' : ''}>Press (Quicker)</option>
              <option value="delayed_press" ${activationValue === 'delayed_press' ? 'selected' : ''}>Delayed Press</option>
              <option value="delayed_press_medium" ${activationValue === 'delayed_press_medium' ? 'selected' : ''}>Delayed Press (Medium)</option>
              <option value="delayed_press_long" ${activationValue === 'delayed_press_long' ? 'selected' : ''}>Delayed Press (Long)</option>
              <option value="tap" ${activationValue === 'tap' ? 'selected' : ''}>Tap</option>
              <option value="tap_quicker" ${activationValue === 'tap_quicker' ? 'selected' : ''}>Tap (Quicker)</option>
              <option value="double_tap" ${activationValue === 'double_tap' ? 'selected' : ''}>Double Tap</option>
              <option value="double_tap_nonblocking" ${activationValue === 'double_tap_nonblocking' ? 'selected' : ''}>Double Tap (Non-blocking)</option>
              <option value="hold" ${activationValue === 'hold' ? 'selected' : ''}>Hold</option>
              <option value="delayed_hold" ${activationValue === 'delayed_hold' ? 'selected' : ''}>Delayed Hold</option>
              <option value="delayed_hold_long" ${activationValue === 'delayed_hold_long' ? 'selected' : ''}>Delayed Hold (Long)</option>
              <option value="hold_no_retrigger" ${activationValue === 'hold_no_retrigger' ? 'selected' : ''}>Hold (No Retrigger)</option>
              <option value="hold_toggle" ${activationValue === 'hold_toggle' ? 'selected' : ''}>Hold Toggle</option>
              <option value="smart_toggle" ${activationValue === 'smart_toggle' ? 'selected' : ''}>Smart Toggle</option>
              <option value="all" ${activationValue === 'all' ? 'selected' : ''}>All</option>
            </select>
          </div>
          <div class="action-binding-remove">
            <button onclick="removeBindingFromModal(${index})" ${removeButtonDisabled}>×</button>
          </div>
        </div>
      `;
    });
  }

  if (html === '')
  {
    html = '<div class="empty-state"><p>No actions match your current filters</p></div>';
  }

  listContainer.innerHTML = html;
  modal.style.display = 'flex';

  // Initialize custom dropdowns for activation mode selects with tooltips
  const activationModeTooltips = {
    '': 'Default behavior - activates on button press',
    'press': 'Standard press activation',
    'press_quicker': 'Press with reduced response time',
    'delayed_press': 'Waits before activating (standard delay)',
    'delayed_press_medium': 'Waits before activating (medium delay)',
    'delayed_press_long': 'Waits before activating (long delay)',
    'tap': 'Quick tap to activate',
    'tap_quicker': 'Quick tap with reduced response time',
    'double_tap': 'Requires two quick taps to activate',
    'double_tap_nonblocking': 'Double tap that allows continuous input',
    'hold': 'Activate by holding the button down',
    'delayed_hold': 'Hold with a delay before activation',
    'delayed_hold_long': 'Hold with a longer delay before activation',
    'hold_no_retrigger': 'Hold without repeating while held',
    'hold_toggle': 'Toggle between on/off by holding',
    'smart_toggle': 'Intelligent toggle based on input pattern',
    'all': 'Activate on any input type'
  };

  const activationSelects = document.querySelectorAll('.binding-activation-select');
  activationSelects.forEach(select =>
  {
    // Store the original select so we can read its value later
    select.dataset.originalSelect = 'true';
    new CustomDropdown(select, {
      optionTooltips: activationModeTooltips
    });
  });

  // Setup event listeners for modal buttons
  document.getElementById('action-bindings-cancel-btn').onclick = closeActionBindingsModal;
  document.getElementById('action-bindings-save-btn').onclick = saveActionBindingsChanges;
  document.getElementById('action-bindings-add-btn').onclick = addNewBindingFromModal;
}

function closeActionBindingsModal()
{
  document.getElementById('action-bindings-modal').style.display = 'none';
  currentActionBindingsData = null;
}

async function saveActionBindingsChanges()
{
  if (!currentActionBindingsData) return;

  const { actionMapName, actionName } = currentActionBindingsData;

  // Get all activation mode selects (the original select elements)
  const selects = document.querySelectorAll('.binding-activation-select');

  // Get the action data
  const actionMap = window.getCurrentKeybindings().action_maps.find(am => am.name === actionMapName);
  if (!actionMap) return;

  const action = actionMap.actions.find(a => a.name === actionName);
  if (!action) return;

  // Update each binding's activation mode
  const updatePromises = [];

  selects.forEach(select =>
  {
    const index = parseInt(select.dataset.bindingIndex);
    // Get value from the custom dropdown (it updates the hidden select)
    const newActivationMode = select.value || null;
    const binding = action.bindings[index];
    const currentActivationMode = binding.activation_mode || null;

    if (binding && currentActivationMode !== newActivationMode)
    {
      console.log(`Updating activation mode for binding ${index}: ${currentActivationMode} -> ${newActivationMode}`);

      // If this is a default binding, we're creating a custom binding with the same input
      if (binding.is_default)
      {
        console.log(`Creating custom binding from default: ${binding.input} with activation mode: ${newActivationMode}`);
      }

      // Update via backend
      const promise = invoke('update_binding', {
        actionMapName,
        actionName,
        newInput: binding.input,
        multiTap: binding.multi_tap,
        activationMode: newActivationMode
      }).catch(err =>
      {
        console.error('Failed to update binding:', err);
      });

      updatePromises.push(promise);
    }
  });

  if (updatePromises.length > 0)
  {
    // Wait for all updates to complete
    await Promise.all(updatePromises);

    // Mark as unsaved
    window.setHasUnsavedChanges(true);
    updateUnsavedIndicator();

    // Refresh bindings
    await window.refreshBindings();
  }

  closeActionBindingsModal();
}

async function removeBindingFromModal(index)
{
  if (!currentActionBindingsData) return;

  const { actionMapName, actionName, actionDisplayName } = currentActionBindingsData;

  // Get the action data
  const actionMap = window.getCurrentKeybindings().action_maps.find(am => am.name === actionMapName);
  if (!actionMap) return;

  const action = actionMap.actions.find(a => a.name === actionName);
  if (!action || !action.bindings[index]) return;

  const binding = action.bindings[index];
  if (!binding || !binding.input) return;

  const removalSucceeded = await window.removeBinding(actionMapName, actionName, binding.input);
  if (!removalSucceeded) return;

  const modal = document.getElementById('action-bindings-modal');
  if (modal && modal.style.display !== 'none')
  {
    openActionBindingsModal(actionMapName, actionName, actionDisplayName || action.display_name || action.name);
  }
}

function addNewBindingFromModal()
{
  if (!currentActionBindingsData) return;

  const { actionMapName, actionName, actionDisplayName } = currentActionBindingsData;

  pendingActionBindingsReturn = {
    actionMapName,
    actionName,
    actionDisplayName
  };

  // Close this modal and open the binding detection modal
  closeActionBindingsModal();
  window.startBinding(actionMapName, actionName, actionDisplayName);
}

// Make it globally available
window.openActionBindingsModal = openActionBindingsModal;
window.removeBindingFromModal = removeBindingFromModal;
window.consumePendingActionBindingsReturn = function ()
{
  const pending = pendingActionBindingsReturn;
  pendingActionBindingsReturn = null;
  return pending;
};
window.clearPendingActionBindingsReturn = function ()
{
  pendingActionBindingsReturn = null;
};

// ============================================================================
// CLEAR SC BINDS FUNCTIONS
// ============================================================================

/**
 * Populate joystick checkboxes dynamically based on max joystick setting
 */
function populateUnbindJoystickCheckboxes()
{
  const container = document.getElementById('unbind-joysticks-list');
  if (!container) return;

  const maxJs = window.getMaxJoysticks ? window.getMaxJoysticks() : 4;
  let html = '';

  for (let i = 1; i <= maxJs; i++)
  {
    // Check the first 2 by default for backwards compatibility
    const checked = i <= 2 ? 'checked' : '';
    html += `
      <div class="checkbox-container" style="margin-bottom: 0.5rem;">
        <input type="checkbox" id="unbind-joystick${i}" ${checked} />
        <label for="unbind-joystick${i}">Joystick ${i}</label>
      </div>`;
  }

  container.innerHTML = html;
}

function openClearSCBindsModal()
{
  // Populate joystick checkboxes dynamically
  populateUnbindJoystickCheckboxes();

  const modal = document.getElementById('clear-sc-binds-modal');
  modal.style.display = 'flex';
}

function closeClearSCBindsModal()
{
  const modal = document.getElementById('clear-sc-binds-modal');
  modal.style.display = 'none';
}

function closeClearSCBindsSuccessModal()
{
  const modal = document.getElementById('clear-sc-binds-success-modal');
  modal.style.display = 'none';
}

async function generateUnbindProfile()
{
  const statusDiv = document.getElementById('clear-binds-status');

  try
  {
    // Build joysticks array dynamically based on max setting
    const maxJs = window.getMaxJoysticks ? window.getMaxJoysticks() : 4;
    const joysticks = [];
    for (let i = 1; i <= maxJs; i++)
    {
      const checkbox = document.getElementById(`unbind-joystick${i}`);
      joysticks.push(checkbox ? checkbox.checked : false);
    }

    // Get selected devices
    const devices = {
      keyboard: document.getElementById('unbind-keyboard').checked,
      mouse: document.getElementById('unbind-mouse').checked,
      gamepad: document.getElementById('unbind-gamepad').checked,
      joysticks: joysticks,
    };

    // Check if at least one device is selected
    const hasDevice = devices.keyboard || devices.mouse || devices.gamepad || joysticks.some(v => v);
    if (!hasDevice)
    {
      statusDiv.style.display = 'block';
      statusDiv.style.color = 'var(--accent-primary)';
      statusDiv.textContent = '⚠️ Please select at least one device to unbind.';
      return;
    }

    // Get the SC installation path from localStorage
    const scInstallPath = localStorage.getItem('scInstallDirectory');
    if (!scInstallPath)
    {
      statusDiv.style.display = 'block';
      statusDiv.style.color = 'var(--accent-warning)';
      statusDiv.textContent = '⚠️ No SC installation directory configured. Go to Settings to configure it.';
      return;
    }

    statusDiv.style.display = 'block';
    statusDiv.style.color = 'var(--text-secondary)';
    statusDiv.textContent = '⏳ Generating unbind profile...';

    console.log('Generating unbind profile with base path:', scInstallPath);

    // Call backend to generate the unbind profile
    const result = await invoke('generate_unbind_profile', {
      devices,
      basePath: scInstallPath
    });

    console.log('Unbind profile generation result:', result);

    // Close the main modal
    closeClearSCBindsModal();

    // Show success modal with results
    const successModal = document.getElementById('clear-sc-binds-success-modal');
    const locationsDiv = document.getElementById('unbind-save-locations');

    if (result.saved_locations && result.saved_locations.length > 0)
    {
      let html = '<p><strong>📁 Saved to:</strong></p><ul style="margin: 0.5rem 0 0 1.5rem; padding: 0;">';
      result.saved_locations.forEach(loc =>
      {
        html += `<li><code>${loc}</code></li>`;
      });
      html += '</ul>';
      locationsDiv.innerHTML = html;
    }
    else
    {
      locationsDiv.innerHTML = '<p class="info-text">⚠️ No SC installation directories found. File created in current directory.</p>';
    }

    successModal.style.display = 'flex';

  } catch (error)
  {
    console.error('Error generating unbind profile:', error);
    statusDiv.style.display = 'block';
    statusDiv.style.color = 'var(--accent-primary)';
    statusDiv.textContent = `❌ Error: ${error}`;
  }
}

async function copyUnbindCommand()
{
  const command = 'pp_RebindKeys UNBIND_ALL';

  try
  {
    await navigator.clipboard.writeText(command);

    // Show toast notification
    if (window.toast)
    {
      window.toast.success(`Command copied: ${command}`);
    } else
    {
      // Fallback: Visual feedback on button
      const btn = document.getElementById('copy-unbind-command-btn');
      const originalText = btn.textContent;
      btn.textContent = '✅ Copied!';
      btn.disabled = true;

      setTimeout(() =>
      {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  } catch (error)
  {
    console.error('Failed to copy command:', error);
    if (window.toast)
    {
      window.toast.error('Failed to copy command to clipboard');
    } else
    {
      await showAlert('Failed to copy command to clipboard', 'Error');
    }
  }
}

async function removeUnbindFiles()
{
  const confirmed = await showConfirmation(
    'Are you sure you want to remove the UNBIND_ALL.xml files from all SC installation directories?',
    'Remove Unbind Files'
  );

  if (!confirmed) return;

  try
  {
    const result = await invoke('remove_unbind_profile');

    if (result.removed_count > 0)
    {
      await showAlert(
        `Successfully removed ${result.removed_count} unbind profile file(s).`,
        'Files Removed'
      );
      closeClearSCBindsSuccessModal();
    }
    else
    {
      await showAlert('No unbind profile files found to remove.', 'Info');
    }
  } catch (error)
  {
    console.error('Error removing unbind files:', error);
    await showAlert(`Error removing files: ${error}`, 'Error');
  }
}

// ============================================================================
// RESTORE DEFAULTS FUNCTIONS
// ============================================================================

/**
 * Populate joystick checkboxes dynamically based on max joystick setting
 */
function populateRestoreJoystickCheckboxes()
{
  const container = document.getElementById('restore-joysticks-list');
  if (!container) return;

  const maxJs = window.getMaxJoysticks ? window.getMaxJoysticks() : 4;
  let html = '';

  for (let i = 1; i <= maxJs; i++)
  {
    // Joysticks are unchecked by default for restore
    html += `
      <div class="checkbox-container" style="margin-bottom: 0.5rem;">
        <input type="checkbox" id="restore-joystick${i}" />
        <label for="restore-joystick${i}">Joystick ${i}</label>
      </div>`;
  }

  container.innerHTML = html;
}

function openRestoreDefaultsModal()
{
  // Populate joystick checkboxes dynamically
  populateRestoreJoystickCheckboxes();

  const modal = document.getElementById('restore-defaults-modal');
  modal.style.display = 'flex';
}

function closeRestoreDefaultsModal()
{
  const modal = document.getElementById('restore-defaults-modal');
  modal.style.display = 'none';
}

function closeRestoreDefaultsSuccessModal()
{
  const modal = document.getElementById('restore-defaults-success-modal');
  modal.style.display = 'none';
}

async function generateRestoreDefaultsProfile()
{
  const statusDiv = document.getElementById('restore-defaults-status');

  try
  {
    // Build joysticks array dynamically based on max setting
    const maxJs = window.getMaxJoysticks ? window.getMaxJoysticks() : 4;
    const joysticks = [];
    for (let i = 1; i <= maxJs; i++)
    {
      const checkbox = document.getElementById(`restore-joystick${i}`);
      joysticks.push(checkbox ? checkbox.checked : false);
    }

    // Get selected devices
    const devices = {
      keyboard: document.getElementById('restore-keyboard').checked,
      mouse: document.getElementById('restore-mouse').checked,
      gamepad: document.getElementById('restore-gamepad').checked,
      joysticks: joysticks,
    };

    // Check if at least one device is selected
    const hasDevice = devices.keyboard || devices.mouse || devices.gamepad || joysticks.some(v => v);
    if (!hasDevice)
    {
      statusDiv.style.display = 'block';
      statusDiv.style.color = 'var(--accent-primary)';
      statusDiv.textContent = '⚠️ Please select at least one device to restore.';
      return;
    }

    // Get the SC installation path from localStorage
    const scInstallPath = localStorage.getItem('scInstallDirectory');
    if (!scInstallPath)
    {
      statusDiv.style.display = 'block';
      statusDiv.style.color = 'var(--accent-warning)';
      statusDiv.textContent = '⚠️ No SC installation directory configured. Go to Settings to configure it.';
      return;
    }

    statusDiv.style.display = 'block';
    statusDiv.style.color = 'var(--text-secondary)';
    statusDiv.textContent = '⏳ Generating defaults profile...';

    console.log('Generating restore defaults profile with base path:', scInstallPath);

    // Call backend to generate the restore defaults profile
    const result = await invoke('generate_restore_defaults_profile', {
      devices,
      basePath: scInstallPath
    });

    console.log('Restore defaults profile generation result:', result);

    // Close the main modal
    closeRestoreDefaultsModal();

    // Show success modal with results
    const successModal = document.getElementById('restore-defaults-success-modal');
    const locationsDiv = document.getElementById('restore-defaults-save-locations');

    if (result.saved_locations && result.saved_locations.length > 0)
    {
      let html = '<p><strong>📁 Saved to:</strong></p><ul style="margin: 0.5rem 0 0 1.5rem; padding: 0;">';
      result.saved_locations.forEach(loc =>
      {
        html += `<li><code>${loc}</code></li>`;
      });
      html += '</ul>';
      locationsDiv.innerHTML = html;
    }
    else
    {
      locationsDiv.innerHTML = '<p class="info-text">⚠️ No SC installation directories found. File created in current directory.</p>';
    }

    successModal.style.display = 'flex';

  } catch (error)
  {
    console.error('Error generating restore defaults profile:', error);
    statusDiv.style.display = 'block';
    statusDiv.style.color = 'var(--accent-primary)';
    statusDiv.textContent = `❌ Error: ${error}`;
  }
}

async function copyRestoreDefaultsCommand()
{
  const command = 'pp_RebindKeys RESTORE_DEFAULTS';

  try
  {
    await navigator.clipboard.writeText(command);

    // Show toast notification
    if (window.toast)
    {
      window.toast.success(`Command copied: ${command}`);
    } else
    {
      // Fallback: Visual feedback on button
      const btn = document.getElementById('copy-restore-defaults-command-btn');
      const originalText = btn.textContent;
      btn.textContent = '✅ Copied!';
      btn.disabled = true;

      setTimeout(() =>
      {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  } catch (error)
  {
    console.error('Failed to copy command:', error);
    if (window.toast)
    {
      window.toast.error('Failed to copy command to clipboard');
    } else
    {
      await showAlert('Failed to copy command to clipboard', 'Error');
    }
  }
}

async function removeRestoreDefaultsFiles()
{
  const confirmed = await showConfirmation(
    'Are you sure you want to remove the RESTORE_DEFAULTS.xml files from all SC installation directories?',
    'Remove Defaults Files'
  );

  if (!confirmed) return;

  try
  {
    const result = await invoke('remove_restore_defaults_profile');

    if (result.removed_count > 0)
    {
      await showAlert(
        `Successfully removed ${result.removed_count} restore defaults profile file(s).`,
        'Files Removed'
      );
      closeRestoreDefaultsSuccessModal();
    }
    else
    {
      await showAlert('No restore defaults profile files found to remove.', 'Info');
    }
  } catch (error)
  {
    console.error('Error removing restore defaults files:', error);
    await showAlert(`Error removing files: ${error}`, 'Error');
  }
}

// Make functions globally available
window.closeRestoreDefaultsModal = closeRestoreDefaultsModal;
window.closeRestoreDefaultsSuccessModal = closeRestoreDefaultsSuccessModal;

// ============================================================================
// HELP PAGE FUNCTIONS
// ============================================================================

async function copyResortDevicesCommand()
{
  const command = 'pp_resortdevices joystick 1 2';

  try
  {
    // Copy to clipboard
    await navigator.clipboard.writeText(command);

    // Show toast notification
    if (window.toast)
    {
      window.toast.success(`Command copied: ${command}`);
    } else
    {
      // Fallback: Show temporary success message on button
      const btn = document.getElementById('copy-resort-devices-btn');
      if (btn)
      {
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        btn.style.opacity = '0.8';

        setTimeout(() =>
        {
          btn.textContent = originalText;
          btn.style.opacity = '1';
        }, 2000);
      }
    }

    // Log the command for user convenience
    console.log('Command copied to clipboard:', command);
  } catch (error)
  {
    console.error('Failed to copy to clipboard:', error);
    if (window.toast)
    {
      window.toast.error('Failed to copy command to clipboard');
    } else
    {
      await showAlert('Failed to copy command to clipboard', 'Error');
    }
  }
}

// Make functions globally available
window.closeClearSCBindsModal = closeClearSCBindsModal;
window.closeClearSCBindsSuccessModal = closeClearSCBindsSuccessModal;
window.copyResortDevicesCommand = copyResortDevicesCommand;

// ============================================================================
// AUTO-SAVE MODAL FUNCTIONS
// ============================================================================

async function openAutoSaveModal()
{
  const modal = document.getElementById('auto-save-modal');
  const scNotConfigured = document.getElementById('auto-save-sc-not-configured');
  const scConfigured = document.getElementById('auto-save-sc-configured');
  const autoSaveCheckbox = document.getElementById('auto-save-all-checkbox');
  const installationsList = document.getElementById('auto-save-installations-list');

  const scInstallPath = localStorage.getItem('scInstallDirectory');

  if (!scInstallPath)
  {
    // Show "not configured" message with button to go to settings
    scNotConfigured.style.display = 'block';
    scConfigured.style.display = 'none';
  }
  else
  {
    // Show auto-save options
    scNotConfigured.style.display = 'none';
    scConfigured.style.display = 'block';

    // Load checkbox state
    const autoSaveEnabled = localStorage.getItem('autoSaveToAllInstallations') === 'true';
    autoSaveCheckbox.checked = autoSaveEnabled;

    // Scan and display installations
    try
    {
      installationsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.9rem;">Scanning...</div>';
      const installations = await invoke('scan_sc_installations', { basePath: scInstallPath });

      if (installations.length === 0)
      {
        installationsList.innerHTML = '<div style="color: var(--text-secondary); font-style: italic;">No installations found</div>';
      }
      else
      {
        installationsList.innerHTML = installations.map(inst =>
          `<div style="padding: 0.25rem 0;">🚀 ${inst.name}</div>`
        ).join('');
      }
    }
    catch (error)
    {
      console.error('Error scanning installations:', error);
      installationsList.innerHTML = `<div style="color: #ff6464;">Error: ${error}</div>`;
    }
  }

  modal.style.display = 'flex';
}

function closeAutoSaveModal()
{
  const modal = document.getElementById('auto-save-modal');
  modal.style.display = 'none';
}

// Make functions globally available
window.openAutoSaveModal = openAutoSaveModal;
window.closeAutoSaveModal = closeAutoSaveModal;
