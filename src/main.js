const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open, save } = window.__TAURI__.dialog;
import { toStarCitizenFormat } from './input-utils.js';
import { initializeUpdateChecker } from './update-checker.js';

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

// Keyboard detection state
let keyboardDetectionActive = false;
let keyboardDetectionHandler = null;
let isDetectionActive = false; // Global flag to track if input detection is active
let currentBindingId = null; // Unique ID for the current binding attempt - helps ignore stale events

// State
let currentKeybindings = null;
let currentFilter = 'all';
let currentCategory = null;
let searchTerm = '';
let bindingMode = false;
let currentBindingAction = null;
let countdownInterval = null;
let keyboardCompletionTimeout = null;
let hasUnsavedChanges = false;
let customizedOnly = false;
let currentTab = 'main';
let categoryFriendlyNames = {};

// Convert JavaScript KeyboardEvent.code to Star Citizen keyboard format
function convertKeyCodeToSC(code, key)
{
  // Handle special keys
  const specialKeys = {
    'Space': 'space',
    'Enter': 'enter',
    'Escape': 'escape',
    'Tab': 'tab',
    'Backspace': 'backspace',
    'Delete': 'delete',
    'Insert': 'insert',
    'Home': 'home',
    'End': 'end',
    'PageUp': 'pgup',
    'PageDown': 'pgdown',
    'ArrowUp': 'up',
    'ArrowDown': 'down',
    'ArrowLeft': 'left',
    'ArrowRight': 'right',
    'CapsLock': 'capslock',
    'NumLock': 'numlock',
    'ScrollLock': 'scrolllock',
    'Pause': 'pause',
    'PrintScreen': 'print',
    'ContextMenu': 'apps',
    'Backquote': 'grave',
    'Minus': 'minus',
    'Equal': 'equals',
    'BracketLeft': 'lbracket',
    'BracketRight': 'rbracket',
    'Backslash': 'backslash',
    'Semicolon': 'semicolon',
    'Quote': 'apostrophe',
    'Comma': 'comma',
    'Period': 'period',
    'Slash': 'slash',
  };

  if (specialKeys[code])
  {
    return specialKeys[code];
  }

  // Handle letter keys (KeyA -> a)
  if (code.startsWith('Key'))
  {
    return code.substring(3).toLowerCase();
  }

  // Handle number keys (Digit1 -> 1)
  if (code.startsWith('Digit'))
  {
    return code.substring(5);
  }

  // Handle numpad keys (Numpad1 -> np_1)
  if (code.startsWith('Numpad'))
  {
    const numpadKey = code.substring(6).toLowerCase();
    const numpadMap = {
      'divide': 'np_divide',
      'multiply': 'np_multiply',
      'subtract': 'np_subtract',
      'add': 'np_add',
      'enter': 'np_enter',
      'decimal': 'np_period',
    };
    return numpadMap[numpadKey] || `np_${numpadKey}`;
  }

  // Handle function keys (F1 -> f1)
  if (code.match(/^F\d+$/))
  {
    return code.toLowerCase();
  }

  // Handle modifiers (these are typically detected as part of combinations)
  if (code === 'ShiftLeft') return 'lshift';
  if (code === 'ShiftRight') return 'rshift';
  if (code === 'ControlLeft') return 'lctrl';
  if (code === 'ControlRight') return 'rctrl';
  if (code === 'AltLeft') return 'lalt';
  if (code === 'AltRight') return 'ralt';
  if (code === 'MetaLeft' || code === 'MetaRight') return 'lwin'; // Windows key

  // Fallback to lowercase key
  return key.toLowerCase();
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

// Main app initialization
window.addEventListener("DOMContentLoaded", async () =>
{
  initializeEventListeners();
  initializeTabSystem();

  // Initialize update checker
  try
  {
    await initializeUpdateChecker();
  } catch (error)
  {
    console.error('Failed to initialize update checker:', error);
    // Don't block app startup if update checker fails
  }

  // Show default file indicator
  document.getElementById('loaded-file-indicator').style.display = 'flex';

  // Load persisted template name
  const savedTemplateName = localStorage.getItem('currentTemplateName');
  if (savedTemplateName)
  {
    updateTemplateIndicator(savedTemplateName);
  }

  // Load categories
  try
  {
    await loadCategoryMappings();
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
    alert(`Warning: Failed to load AllBinds.xml: ${error}\n\nSome features may not work correctly.`);
  }

  loadPersistedKeybindings();
});

function initializeTabSystem()
{
  // Add tab click handlers
  document.querySelectorAll('.tab-btn').forEach(btn =>
  {
    btn.addEventListener('click', (e) =>
    {
      const tabName = e.target.dataset.tab;
      switchTab(tabName);
    });
  });

  // Save current tab to localStorage
  const savedTab = localStorage.getItem('currentTab') || 'main';
  switchTab(savedTab);
}

async function loadCategoryMappings()
{
  try
  {
    // Use Tauri's resource resolver to load from the app directory
    const response = await fetch(new URL('../Categories.json', import.meta.url).href);
    if (!response.ok)
    {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();

    // Convert array of objects to a flat mapping object
    // e.g., { "@ui_CCSpaceFlight": "Space Flight Controls", ... }
    categoryFriendlyNames = {};
    data.categories.forEach(categoryObj =>
    {
      // Each category object has one key-value pair
      const entries = Object.entries(categoryObj);
      if (entries.length > 0)
      {
        const [key, value] = entries[0];
        categoryFriendlyNames[key] = value;
      }
    });

    console.log('Category mappings loaded:', categoryFriendlyNames);
  } catch (error)
  {
    console.error('Error loading Categories.json:', error);
    // Set default fallback mapping to ensure the app still works
    categoryFriendlyNames = {
      '@ui_CCSeatGeneral': 'General Seat Controls',
      '@ui_CCSpaceFlight': 'Space Flight Controls',
      '@ui_CCOrientationControl': 'Orientation Control',
      '@ui_CCFlightModes': 'Flight Modes',
      '@ui_CCTurrets': 'Turrets',
      '@ui_CGLightControllerDesc': 'Light Controller',
      '@ui_CCFPS': 'First Person Shooter Controls',
      '@ui_CCEVA': 'EVA Controls',
      '@ui_CCEVAZGT': 'EVA Zero Gravity Traversal',
      '@ui_CCVehicle': 'Vehicle Controls',
      '@ui_CC_DriveModes': 'Drive Modes',
      '@ui_CGEASpectator': 'Spectator Mode',
      '@ui_CGUIGeneral': 'General UI Controls',
      '@ui_CGOpticalTracking': 'Optical Tracking',
      '@ui_CGInteraction': 'Interaction',
      '@ui_CCCamera': 'Camera Controls',
      '': 'Uncategorized'
    };
  }
}

function switchTab(tabName)
{
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
  document.body.classList.remove('tab-main', 'tab-visual', 'tab-template', 'tab-debugger');
  document.body.classList.add(`tab-${tabName}`);

  // Save to localStorage
  localStorage.setItem('currentTab', tabName);

  // Handle tab-specific initialization
  if (tabName === 'visual')
  {
    // Initialize visual view if needed
    if (window.initializeVisualView)
    {
      window.initializeVisualView();
    }
    // Refresh visual view when switching to it
    if (window.refreshVisualView)
    {
      window.refreshVisualView();
    }
  }
  else if (tabName === 'template')
  {
    // Initialize template editor if needed
    if (window.initializeTemplateEditor)
    {
      window.initializeTemplateEditor();
    }
  }
  else if (tabName === 'debugger')
  {
    // Initialize debugger if needed
    if (window.initializeDebugger)
    {
      window.initializeDebugger();
    }
  }
}

function initializeEventListeners()
{
  // Load button
  const loadBtn = document.getElementById('load-btn');
  const welcomeLoadBtn = document.getElementById('welcome-load-btn');
  if (loadBtn) loadBtn.addEventListener('click', loadKeybindingsFile);
  if (welcomeLoadBtn) welcomeLoadBtn.addEventListener('click', loadKeybindingsFile);

  // Save buttons
  const saveBtn = document.getElementById('save-btn');
  const saveAsBtn = document.getElementById('save-as-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveKeybindings);
  if (saveAsBtn) saveAsBtn.addEventListener('click', saveKeybindingsAs);

  // SC Directory button
  const scDirectoryBtn = document.getElementById('sc-directory-btn');
  if (scDirectoryBtn) scDirectoryBtn.addEventListener('click', () =>
  {
    window.location.href = 'sc-directory.html';
  });

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
        currentFilter = e.target.dataset.filter;
        renderKeybindings();
      });
    });
  }

  // Search input
  const searchInput = document.getElementById('search-input');
  if (searchInput)
  {
    searchInput.addEventListener('input', (e) =>
    {
      searchTerm = e.target.value.toLowerCase();
      renderKeybindings();
    });
  }

  // Customized only checkbox
  const customizedCheckbox = document.getElementById('customized-only-checkbox');
  if (customizedCheckbox)
  {
    customizedCheckbox.addEventListener('change', (e) =>
    {
      customizedOnly = e.target.checked;
      renderKeybindings();
    });
  }

  // Binding modal buttons
  const bindingCancelBtn = document.getElementById('binding-cancel-btn');
  const bindingResetBtn = document.getElementById('binding-reset-btn');
  const bindingClearBtn = document.getElementById('binding-clear-btn');
  if (bindingCancelBtn) bindingCancelBtn.addEventListener('click', cancelBinding);
  if (bindingResetBtn) bindingResetBtn.addEventListener('click', resetBinding);
  if (bindingClearBtn) bindingClearBtn.addEventListener('click', clearBinding);

  // Conflict modal buttons
  const conflictCancelBtn = document.getElementById('conflict-cancel-btn');
  const conflictConfirmBtn = document.getElementById('conflict-confirm-btn');
  if (conflictCancelBtn) conflictCancelBtn.addEventListener('click', closeConflictModal);
  if (conflictConfirmBtn) conflictConfirmBtn.addEventListener('click', confirmConflictBinding);

  // Joystick mapping modal buttons
  const configureBtn = document.getElementById('configure-joystick-mapping-btn');
  const joyMappingClose = document.getElementById('joystick-mapping-close');
  const joyMappingCancel = document.getElementById('joystick-mapping-cancel');
  const detectJs1Btn = document.getElementById('detect-js1-btn');
  const detectJs2Btn = document.getElementById('detect-js2-btn');
  const detectGp1Btn = document.getElementById('detect-gp1-btn');
  const joyMappingSave = document.getElementById('joystick-mapping-save');
  if (configureBtn) configureBtn.addEventListener('click', openJoystickMappingModal);
  if (joyMappingClose) joyMappingClose.addEventListener('click', closeJoystickMappingModal);
  if (joyMappingCancel) joyMappingCancel.addEventListener('click', closeJoystickMappingModal);
  if (detectJs1Btn) detectJs1Btn.addEventListener('click', () => detectDevice('js1'));
  if (detectJs2Btn) detectJs2Btn.addEventListener('click', () => detectDevice('js2'));
  if (detectGp1Btn) detectGp1Btn.addEventListener('click', () => detectDevice('gp1'));
  if (joyMappingSave) joyMappingSave.addEventListener('click', saveJoystickMapping);
}

async function loadKeybindingsFile()
{
  try
  {
    const filePath = await open({
      filters: [{
        name: 'Star Citizen Keybindings',
        extensions: ['xml']
      }],
      multiple: false
    });

    if (!filePath) return; // User cancelled

    // Load the keybindings (this loads into state on backend)
    await invoke('load_keybindings', { filePath });

    // Now get the merged bindings (AllBinds + user customizations)
    currentKeybindings = await invoke('get_merged_bindings');

    // Save working copy to localStorage for cross-view access
    localStorage.setItem('workingBindings', JSON.stringify(currentKeybindings));

    // Persist file path so we know where to save
    localStorage.setItem('keybindingsFilePath', filePath);

    // Reset unsaved changes flag
    hasUnsavedChanges = false;
    localStorage.setItem('hasUnsavedChanges', 'false');
    updateUnsavedIndicator();

    // Update UI
    displayKeybindings();
    updateFileIndicator(filePath);

  } catch (error)
  {
    console.error('Error loading keybindings:', error);
    alert(`Failed to load keybindings: ${error}`);
  }
}

async function loadPersistedKeybindings()
{
  try
  {
    // First, check if we have a working copy of bindings
    const workingBindings = localStorage.getItem('workingBindings');
    const cachedUnsavedState = localStorage.getItem('hasUnsavedChanges');
    const savedPath = localStorage.getItem('keybindingsFilePath');

    if (workingBindings)
    {
      // Use working copy as source of truth for display
      console.log('Loading working copy of bindings');
      currentKeybindings = JSON.parse(workingBindings);
      hasUnsavedChanges = cachedUnsavedState === 'true';
      updateUnsavedIndicator();

      // CRITICAL: Also reload backend state to prevent data loss
      // The backend needs to know about the user's file to properly merge with AllBinds
      if (savedPath)
      {
        try
        {
          console.log('Reloading backend state from:', savedPath);
          await invoke('load_keybindings', { filePath: savedPath });
          console.log('Backend state reloaded successfully');
        } catch (error)
        {
          console.error('Error reloading backend state:', error);
          // Continue with cached data but warn user
          console.warn('Backend state could not be reloaded, using cached data only');
        }
        updateFileIndicator(savedPath);
      }

      displayKeybindings();
      return;
    }

    if (savedPath)
    {
      // Reload the user's keybindings file from disk
      try
      {
        await invoke('load_keybindings', { filePath: savedPath });
        currentKeybindings = await invoke('get_merged_bindings');

        // Save as working copy
        localStorage.setItem('workingBindings', JSON.stringify(currentKeybindings));
        localStorage.setItem('hasUnsavedChanges', 'false');

        displayKeybindings();
        updateFileIndicator(savedPath);
      } catch (error)
      {
        console.error('Error loading persisted file:', error);
        // If loading fails, just show AllBinds without user customizations
        await loadAllBindsOnly();
      }
    } else
    {
      // No user file loaded, just show all available bindings from AllBinds
      await loadAllBindsOnly();
    }
  } catch (error)
  {
    console.error('Error loading persisted keybindings:', error);
  }
}

async function loadAllBindsOnly()
{
  try
  {
    // Get merged bindings with no user customizations
    currentKeybindings = await invoke('get_merged_bindings');

    // Save as working copy
    localStorage.setItem('workingBindings', JSON.stringify(currentKeybindings));
    localStorage.setItem('hasUnsavedChanges', 'false');

    displayKeybindings();
  } catch (error)
  {
    console.error('Error loading AllBinds:', error);
    // Show welcome screen if AllBinds failed to load
  }
}

function updateFileIndicator(filePath)
{
  const indicator = document.getElementById('loaded-file-indicator');
  const fileNameEl = document.getElementById('loaded-file-name');

  if (indicator && fileNameEl)
  {
    // Extract just the filename from the path
    const fileName = filePath.split(/[\\/]/).pop();
    fileNameEl.textContent = fileName;
    indicator.style.display = 'flex';
  }
}

function updateTemplateIndicator(templateName)
{
  const templateNameEl = document.getElementById('header-template-name');
  console.log('updateTemplateIndicator called with:', templateName);
  console.log('templateNameEl:', templateNameEl);
  if (templateNameEl)
  {
    templateNameEl.textContent = templateName || 'Untitled Template';
    console.log('Updated header to:', templateNameEl.textContent);
  }
  // Always save to localStorage for persistence
  if (templateName)
  {
    localStorage.setItem('currentTemplateName', templateName);
  }
}

// Make it globally accessible
window.updateTemplateIndicator = updateTemplateIndicator;

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

async function saveKeybindings()
{
  if (!currentKeybindings)
  {
    alert('No keybindings loaded to save!');
    return;
  }

  try
  {
    // Get the saved file path
    const savedPath = localStorage.getItem('keybindingsFilePath');

    if (!savedPath)
    {
      // No file path - redirect to Save As
      await saveKeybindingsAs();
      return;
    }

    // Save to the current file path
    await invoke('export_keybindings', { filePath: savedPath });

    // Clear unsaved changes flag
    hasUnsavedChanges = false;
    localStorage.setItem('hasUnsavedChanges', 'false');
    updateUnsavedIndicator();

    console.log('Keybindings saved successfully to:', savedPath);

    // Check if auto-save to all installations is enabled
    const autoSaveEnabled = localStorage.getItem('autoSaveToAllInstallations') === 'true';
    const scInstallDirectory = localStorage.getItem('scInstallDirectory');

    if (autoSaveEnabled && scInstallDirectory)
    {
      try
      {
        // Get all detected installations
        const installations = await invoke('scan_sc_installations', { basePath: scInstallDirectory });

        if (installations.length > 0)
        {
          console.log(`Auto-saving to ${installations.length} installation(s)...`);

          // Save to each installation
          for (const installation of installations)
          {
            await invoke('save_bindings_to_install', {
              installationPath: installation.path
            });
            console.log(`Saved to ${installation.name}`);
          }

          showSuccessMessage(`Saved & deployed to ${installations.length} installation(s)!`);
        } else
        {
          showSuccessMessage('Saved!');
        }
      } catch (error)
      {
        console.error('Error auto-saving to installations:', error);
        showSuccessMessage('Saved (failed to deploy to installations)');
      }
    } else
    {
      // Show brief success message
      showSuccessMessage('Saved!');
    }
  } catch (error)
  {
    console.error('Error saving keybindings:', error);
    alert(`Failed to save keybindings: ${error}`);
  }
}

async function saveKeybindingsAs()
{
  if (!currentKeybindings)
  {
    alert('No keybindings loaded to save!');
    return;
  }

  try
  {
    // Prompt for a new file path
    const filePath = await save({
      filters: [{
        name: 'Star Citizen Keybindings',
        extensions: ['xml']
      }],
      defaultPath: 'layout_exported.xml'
    });

    if (!filePath)
    {
      // User cancelled
      return;
    }

    // Save to the new file path
    await invoke('export_keybindings', { filePath });

    // Update the stored file path
    localStorage.setItem('keybindingsFilePath', filePath);
    updateFileIndicator(filePath);

    // Clear unsaved changes flag
    hasUnsavedChanges = false;
    localStorage.setItem('hasUnsavedChanges', 'false');
    updateUnsavedIndicator();

    console.log('Keybindings saved successfully to:', filePath);

    // Show brief success message
    showSuccessMessage('Saved!');
  } catch (error)
  {
    console.error('Error saving keybindings:', error);
    alert(`Failed to save keybindings: ${error}`);
  }
}

function showSuccessMessage(message)
{
  // Create a temporary success indicator
  const indicator = document.createElement('div');
  indicator.textContent = message;
  indicator.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    background-color: #28a745;
    color: white;
    padding: 12px 24px;
    border-radius: 4px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
  `;

  document.body.appendChild(indicator);

  // Remove after 2 seconds
  setTimeout(() =>
  {
    indicator.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => indicator.remove(), 300);
  }, 2000);
}

function displayKeybindings()
{
  if (!currentKeybindings) return;

  // Hide welcome screen, show bindings content
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('bindings-content').style.display = 'flex';

  // Enable save buttons
  document.getElementById('save-btn').disabled = false;
  document.getElementById('save-as-btn').disabled = false;

  // Update profile name - use a default if not available
  const profileName = currentKeybindings.profile_name || 'Star Citizen Keybindings';
  document.getElementById('profile-name').textContent = profileName;

  // Render categories
  renderCategories();

  // Don't render device info for merged bindings (AllBinds doesn't have device info)
  if (currentKeybindings.devices)
  {
    renderDeviceInfo();
  }

  // Render keybindings
  renderKeybindings();
}

function renderCategories()
{
  const categoryList = document.getElementById('category-list');

  // Group action maps by their UICategory
  const categoryGroups = new Map();

  currentKeybindings.action_maps.forEach(actionMap =>
  {
    // Use ui_category if available, otherwise use a default group
    const category = actionMap.ui_category || '';

    if (!categoryGroups.has(category))
    {
      categoryGroups.set(category, []);
    }
    categoryGroups.get(category).push(actionMap);
  });

  // Sort categories alphabetically, but keep empty string at the end
  const sortedCategories = Array.from(categoryGroups.keys()).sort((a, b) =>
  {
    if (a === '') return 1;
    if (b === '') return -1;
    return a.localeCompare(b);
  });

  let html = `
    <div class="category-item ${currentCategory === null ? 'active' : ''}" 
         data-category="all">
      All Categories
    </div>
  `;

  // Render grouped categories
  sortedCategories.forEach(categoryName =>
  {
    const actionMaps = categoryGroups.get(categoryName);

    // Get friendly name from mapping, fallback to original category name
    const friendlyName = categoryFriendlyNames[categoryName] || categoryName || 'Uncategorized';

    // Add category header if we have multiple action maps in this category
    if (actionMaps.length > 1)
    {
      html += `<div class="category-header">${friendlyName}</div>`;
    }

    // Add action maps under this category
    actionMaps.forEach(actionMap =>
    {
      const displayName = actionMap.ui_label || actionMap.display_name || actionMap.name;
      const isActive = currentCategory === actionMap.name;
      const indent = actionMaps.length > 1 ? 'category-item-indented' : '';

      html += `
        <div class="category-item ${isActive ? 'active' : ''} ${indent}" 
             data-category="${actionMap.name}">
          ${displayName}
        </div>
      `;
    });
  });

  categoryList.innerHTML = html;

  // Add click listeners
  categoryList.querySelectorAll('.category-item').forEach(item =>
  {
    item.addEventListener('click', (e) =>
    {
      // Only remove active from items within this category list, not filter buttons
      categoryList.querySelectorAll('.category-item').forEach(i => i.classList.remove('active'));
      e.target.classList.add('active');
      currentCategory = e.target.dataset.category === 'all' ? null : e.target.dataset.category;
      renderKeybindings();
    });
  });
}

function renderDeviceInfo()
{
  const deviceList = document.getElementById('device-list');

  let html = '';

  if (currentKeybindings.devices.keyboards.length > 0)
  {
    html += '<div class="device-item"><div class="device-label">Keyboard</div>';
    currentKeybindings.devices.keyboards.forEach(kb =>
    {
      html += `<div>${kb}</div>`;
    });
    html += '</div>';
  }

  if (currentKeybindings.devices.mice.length > 0)
  {
    html += '<div class="device-item"><div class="device-label">Mouse</div>';
    currentKeybindings.devices.mice.forEach(mouse =>
    {
      html += `<div>${mouse}</div>`;
    });
    html += '</div>';
  }

  if (currentKeybindings.devices.joysticks.length > 0)
  {
    html += '<div class="device-item"><div class="device-label">Joysticks</div>';
    currentKeybindings.devices.joysticks.forEach(js =>
    {
      html += `<div>${js}</div>`;
    });
    html += '</div>';
  }

  deviceList.innerHTML = html;
}

function renderKeybindings()
{
  if (!currentKeybindings) return;

  const container = document.getElementById('action-maps-container');

  // Filter action maps
  let actionMaps = currentKeybindings.action_maps;

  if (currentCategory)
  {
    actionMaps = actionMaps.filter(am => am.name === currentCategory);
  }

  let html = '';

  actionMaps.forEach(actionMap =>
  {
    // Use ui_label if available (from merged bindings), otherwise use display_name
    const actionMapLabel = actionMap.ui_label || actionMap.display_name || actionMap.name;

    // Filter actions based on search term and input type filter
    let actions = actionMap.actions.filter(action =>
    {
      // Use ui_label if available, otherwise display_name
      const displayName = action.ui_label || action.display_name || action.name;

      // Input type filter
      if (currentFilter !== 'all')
      {
        const hasMatchingBinding = action.bindings && action.bindings.some(binding =>
        {
          if (currentFilter === 'keyboard') return binding.input_type === 'Keyboard';
          if (currentFilter === 'mouse') return binding.input_type === 'Mouse';
          if (currentFilter === 'joystick') return binding.input_type === 'Joystick';
          if (currentFilter === 'gamepad') return binding.input_type === 'Gamepad';
          return true;
        });

        if (!hasMatchingBinding) return false;
      }

      // Customized only filter - if checked, skip actions without customized bindings for the current device type
      if (customizedOnly)
      {
        const hasCustomizedBinding = action.bindings && action.bindings.some(binding =>
        {
          // Check if this binding is customized (not default)
          if (binding.is_default) return false;

          // If a specific device type is selected, only count customizations for that type
          if (currentFilter !== 'all')
          {
            if (currentFilter === 'keyboard' && binding.input_type !== 'Keyboard') return false;
            if (currentFilter === 'mouse' && binding.input_type !== 'Mouse') return false;
            if (currentFilter === 'joystick' && binding.input_type !== 'Joystick') return false;
            if (currentFilter === 'gamepad' && binding.input_type !== 'Gamepad') return false;
          }

          return true;
        });

        if (!hasCustomizedBinding) return false;
      }

      // Search filter - search in action name AND binding names
      if (searchTerm)
      {
        const searchInAction = displayName.toLowerCase().includes(searchTerm) ||
          action.name.toLowerCase().includes(searchTerm);

        const searchInBindings = action.bindings && action.bindings.some(binding =>
          binding.display_name.toLowerCase().includes(searchTerm) ||
          binding.input.toLowerCase().includes(searchTerm)
        );

        if (!searchInAction && !searchInBindings)
        {
          return false;
        }
      }

      return true;
    });

    if (actions.length === 0) return; // Skip empty action maps

    html += `
      <div class="action-map">
        <div class="action-map-header" onclick="toggleActionMap(this)">
          <h3>${actionMapLabel}</h3>
          <span class="action-map-toggle">▼</span>
        </div>
        <div class="actions-list">
    `;

    actions.forEach(action =>
    {
      const displayName = action.ui_label || action.display_name || action.name;
      const isCustomized = action.is_customized || false;
      const onHold = action.on_hold || false;

      html += `
        <div class="action-item ${isCustomized ? 'customized' : ''}">
          <div class="action-name">
            ${isCustomized ? '<span class="customized-indicator" title="Customized binding">★</span>' : ''}
            ${displayName}${onHold ? ' <span class="hold-indicator" title="Requires holding">(Hold)</span>' : ''}
          </div>
          <button class="bind-button btn btn-primary" 
                  data-action-map="${actionMap.name}"
                  data-action-name="${action.name}"
                  data-action-display="${displayName}"
                  onclick="startBinding(this.dataset.actionMap, this.dataset.actionName, this.dataset.actionDisplay)">
            Bind
          </button>
          <div class="bindings-container">
      `;

      if (!action.bindings || action.bindings.length === 0 || action.bindings.every(b => !b.input || b.input.trim() === '' || (b.input.trim().endsWith('_') && !b.is_default) || (b.input.trim().match(/js[12]_\s*$/) && !b.is_default)))
      {
        html += `<span class="binding-tag unbound">Unbound</span>`;
      } else
      {
        action.bindings.forEach(binding =>
        {
          const trimmedInput = binding.input.trim();

          // Check if this is a cleared binding (overriding a default with blank)
          const isClearedBinding = (trimmedInput.endsWith('_') || trimmedInput.match(/js[12]_\s*$/)) && !binding.is_default;

          // Skip truly unbound bindings, but keep cleared bindings that override defaults
          if (!trimmedInput || trimmedInput === '') return;
          if ((trimmedInput.endsWith('_') || trimmedInput.match(/js[12]_\s*$/)) && binding.is_default) return;

          // Filter display based on current filter
          if (currentFilter !== 'all')
          {
            if (currentFilter === 'keyboard' && binding.input_type !== 'Keyboard') return;
            if (currentFilter === 'mouse' && binding.input_type !== 'Mouse') return;
            if (currentFilter === 'joystick' && binding.input_type !== 'Joystick') return;
            if (currentFilter === 'gamepad' && binding.input_type !== 'Gamepad') return;
          }

          let typeClass = 'unbound';
          let icon = '○';

          if (binding.input_type === 'Keyboard')
          {
            typeClass = 'keyboard';
            icon = '⌨';
          } else if (binding.input_type === 'Mouse')
          {
            typeClass = 'mouse';
            icon = '🖱';
          } else if (binding.input_type === 'Joystick')
          {
            typeClass = 'joystick';
            icon = '🕹';
          } else if (binding.input_type === 'Gamepad')
          {
            typeClass = 'gamepad';
            icon = '🎮';
          }

          // Show if it's a default binding or a cleared override
          const defaultIndicator = binding.is_default ? ' (default)' : '';

          html += `
            <span class="binding-tag ${typeClass} ${binding.is_default ? 'default-binding' : ''} ${isClearedBinding ? 'cleared-binding' : ''}">
              <span class="binding-icon">${icon}</span>
              ${isClearedBinding ? 'Cleared Override' : binding.display_name}${defaultIndicator}
              <button class="binding-remove-btn" 
                      title="Clear this binding"
                      data-action-map="${actionMap.name}"
                      data-action-name="${action.name}"
                      data-input="${binding.input.replace(/"/g, '&quot;')}">×</button>
            </span>
          `;
        });
      }

      html += `
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  if (html === '')
  {
    html = '<div class="empty-state"><p>No actions match your current filters</p></div>';
  }

  container.innerHTML = html;

  // Add event delegation for binding remove buttons
  container.querySelectorAll('.binding-remove-btn').forEach(btn =>
  {
    btn.addEventListener('click', async (e) =>
    {
      e.stopPropagation();
      e.preventDefault();

      const actionMap = btn.dataset.actionMap;
      const actionName = btn.dataset.actionName;
      const input = btn.dataset.input;

      await removeBinding(actionMap, actionName, input);
    });
  });
}

// Toggle action map visibility
window.toggleActionMap = function (headerEl)
{
  const actionsList = headerEl.nextElementSibling;
  const toggle = headerEl.querySelector('.action-map-toggle');

  if (actionsList.style.display === 'none')
  {
    actionsList.style.display = 'grid';
    toggle.classList.remove('collapsed');
  } else
  {
    actionsList.style.display = 'none';
    toggle.classList.add('collapsed');
  }
};

// Binding mode functions
async function startBinding(actionMapName, actionName, actionDisplayName)
{
  // Generate unique ID for this binding attempt to ignore stale events
  currentBindingId = Date.now() + Math.random();
  console.log('[TIMER] startBinding called for:', actionDisplayName, 'new currentBindingId:', currentBindingId);

  // Mark any previous detection as inactive
  isDetectionActive = false;

  // Clear any existing countdown timer first
  if (countdownInterval)
  {
    console.log('[TIMER] Clearing existing countdownInterval at start of startBinding, ID:', countdownInterval);
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  else
  {
    console.log('[TIMER] No existing countdownInterval to clear at start of startBinding');
  }

  // Clear any existing keyboard completion timeout
  if (keyboardCompletionTimeout)
  {
    console.log('[TIMER] Clearing existing keyboardCompletionTimeout at start of startBinding');
    clearTimeout(keyboardCompletionTimeout);
    keyboardCompletionTimeout = null;
  }

  // Clean up any leftover listeners from previous binding attempts
  if (window.currentInputDetectionUnlisten)
  {
    window.currentInputDetectionUnlisten();
    window.currentInputDetectionUnlisten = null;
  }
  if (window.currentCompletionUnlisten)
  {
    window.currentCompletionUnlisten();
    window.currentCompletionUnlisten = null;
  }

  // Clean up keyboard detection from previous attempt
  if (keyboardDetectionHandler)
  {
    document.removeEventListener('keydown', keyboardDetectionHandler, true);
    keyboardDetectionHandler = null;
  }
  keyboardDetectionActive = false;

  currentBindingAction = { actionMapName, actionName, actionDisplayName };
  bindingMode = true;

  // Capture the binding ID for this attempt (for closure)
  const thisBindingId = currentBindingId;

  // Show modal
  const modal = document.getElementById('binding-modal');
  modal.style.display = 'flex';

  document.getElementById('binding-modal-action').textContent = actionDisplayName;
  document.getElementById('binding-modal-status').textContent = 'Press any button, key, mouse button, or move any axis...';

  // Start countdown
  const countdown = 10;
  let remaining = countdown;
  const countdownEl = document.getElementById('binding-modal-countdown');
  countdownEl.textContent = countdown;

  console.log('[TIMER] Starting new countdownInterval for binding:', actionDisplayName);
  const intervalId = setInterval(() =>
  {
    remaining--;
    console.log('[TIMER] Countdown tick:', remaining, 'intervalId:', intervalId);
    countdownEl.textContent = remaining;
    if (remaining <= 0)
    {
      console.log('[TIMER] Countdown reached 0, clearing interval:', intervalId);
      clearInterval(intervalId);
      if (countdownInterval === intervalId)
      {
        countdownInterval = null;
      }
    }
  }, 1000);
  countdownInterval = intervalId;
  console.log('[TIMER] countdownInterval ID assigned:', countdownInterval);

  try
  {
    // Set global detection flag to active
    isDetectionActive = true;

    // Track all detected inputs
    const allDetectedInputs = new Map(); // key: input_string, value: processed input object
    let selectionContainer = null;
    let statusEl = document.getElementById('binding-modal-status');

    // Activate keyboard detection
    keyboardDetectionActive = true;

    // Activate mouse button detection
    let mouseDetectionActive = true;
    let mouseDetectionHandler = null;

    // Create mouse event handler
    mouseDetectionHandler = (event) =>
    {
      if (!window.mouseDetectionActive) return;

      // Only capture mouse events within the modal itself
      const modal = document.getElementById('binding-modal');
      if (!modal.contains(event.target)) return;

      // Prevent default browser behavior
      event.preventDefault();
      event.stopPropagation();

      // Map mouse button numbers to Star Citizen format
      const buttonMap = {
        0: 'mouse1',  // Left button
        1: 'mouse3',  // Middle button
        2: 'mouse2',  // Right button
        3: 'mouse4',  // Side button (back)
        4: 'mouse5'   // Side button (forward)
      };

      const scButton = buttonMap[event.button] || `mouse${event.button + 1}`;

      // Build the input string (mouse format)
      const inputString = scButton;

      // Build display name
      const buttonNames = {
        'mouse1': 'Left Mouse Button',
        'mouse2': 'Right Mouse Button',
        'mouse3': 'Middle Mouse Button',
        'mouse4': 'Mouse Button 4',
        'mouse5': 'Mouse Button 5'
      };
      const displayName = buttonNames[scButton] || `Mouse Button ${event.button}`;

      // Create a synthetic event that matches the structure from Rust backend
      const syntheticResult = {
        input_string: inputString,
        display_name: displayName,
        device_type: 'Mouse',
        axis_value: null,
        modifiers: [],
        is_modifier: false
      };

      // Process this mouse input through the same pipeline
      const processed = processInput(syntheticResult);

      if (processed && !allDetectedInputs.has(processed.scFormattedInput))
      {
        allDetectedInputs.set(processed.scFormattedInput, processed);

        if (allDetectedInputs.size === 1)
        {
          // First input detected - show it with confirm/cancel buttons
          statusEl.textContent = `Detected: ${processed.displayName}`;

          // Stop the main countdown timer
          if (countdownInterval)
          {
            console.log('[TIMER] [MOUSE] Clearing countdownInterval after first input, ID:', countdownInterval);
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          else
          {
            console.log('[TIMER] [MOUSE] countdownInterval already null!');
          }
          document.getElementById('binding-modal-countdown').textContent = '';

          // Create confirm/cancel UI
          const confirmUI = document.createElement('div');
          confirmUI.className = 'input-confirm-container';
          confirmUI.innerHTML = `
            <button class="btn btn-primary" id="confirm-single-input">✓ Use This Input</button>
            <div class="input-confirm-note">Or press another input within 1 second to choose...</div>
          `;
          statusEl.appendChild(confirmUI);

          // Confirm button handler
          document.getElementById('confirm-single-input').addEventListener('click', async () =>
          {
            // Mark detection as inactive to ignore any pending events
            isDetectionActive = false;

            // Clean up ALL timers and listeners
            if (keyboardCompletionTimeout)
            {
              clearTimeout(keyboardCompletionTimeout);
              keyboardCompletionTimeout = null;
            }
            if (countdownInterval)
            {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }
            keyboardDetectionActive = false;
            mouseDetectionActive = false;
            if (keyboardDetectionHandler)
            {
              document.removeEventListener('keydown', keyboardDetectionHandler, true);
              keyboardDetectionHandler = null;
            }
            if (mouseDetectionHandler)
            {
              document.removeEventListener('mousedown', mouseDetectionHandler, true);
              document.removeEventListener('contextmenu', contextMenuHandler, true);
              mouseDetectionHandler = null;
            }
            if (window.currentInputDetectionUnlisten)
            {
              window.currentInputDetectionUnlisten();
              window.currentInputDetectionUnlisten = null;
            }
            if (window.currentCompletionUnlisten)
            {
              window.currentCompletionUnlisten();
              window.currentCompletionUnlisten = null;
            }

            const [, singleInput] = Array.from(allDetectedInputs.entries())[0];

            // Check for conflicts
            const conflicts = await invoke('find_conflicting_bindings', {
              input: singleInput.scFormattedInput,
              excludeActionMap: actionMapName,
              excludeAction: actionName
            });

            if (conflicts.length > 0)
            {
              window.pendingBinding = {
                actionMapName,
                actionName,
                mappedInput: singleInput.scFormattedInput,
                displayName: singleInput.displayName
              };
              showConflictModal(conflicts);
              return;
            }

            // No conflicts, proceed with binding
            await applyBinding(actionMapName, actionName, singleInput.scFormattedInput);
          });

          // Start a 1-second timer to auto-show selection UI if more inputs come
          if (keyboardCompletionTimeout) clearTimeout(keyboardCompletionTimeout);
          keyboardCompletionTimeout = setTimeout(() =>
          {
            // After 1 second with no more inputs, just leave the confirm UI showing
            keyboardCompletionTimeout = null;
          }, 1000);
        }
        else if (allDetectedInputs.size === 2)
        {
          // Second input detected - remove confirm UI and switch to selection UI
          if (keyboardCompletionTimeout)
          {
            clearTimeout(keyboardCompletionTimeout);
            keyboardCompletionTimeout = null;
          }

          // Stop the main countdown timer if still running
          if (countdownInterval)
          {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }

          // Clear any existing UI and show selection
          statusEl.innerHTML = '';
          statusEl.textContent = 'Multiple inputs detected - select one:';
          document.getElementById('binding-modal-countdown').textContent = '';

          selectionContainer = document.createElement('div');
          selectionContainer.className = 'input-selection-container';
          statusEl.appendChild(selectionContainer);

          // Add both inputs
          Array.from(allDetectedInputs.values()).forEach((input) =>
          {
            addDetectedInputButton(input);
          });
        }
        else
        {
          // More inputs - just add the new button
          addDetectedInputButton(processed);
        }
      }
    };

    // Prevent right-click context menu during recording
    const contextMenuHandler = (event) =>
    {
      if (!window.mouseDetectionActive) return;
      const modal = document.getElementById('binding-modal');
      if (!modal.contains(event.target)) return;
      event.preventDefault();
    };

    // Prevent browser navigation for back/forward buttons
    const mouseUpHandler = (event) =>
    {
      if (!window.mouseDetectionActive) return;
      const modal = document.getElementById('binding-modal');
      if (!modal.contains(event.target)) return;

      // Prevent default for buttons 3 and 4 (back/forward)
      if (event.button === 3 || event.button === 4)
      {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // Prevent beforeunload navigation during recording
    const beforeUnloadHandler = (event) =>
    {
      if (!window.mouseDetectionActive) return;
      event.preventDefault();
      event.returnValue = '';
    };

    // Store handlers on window for cleanup
    window.mouseDetectionHandler = mouseDetectionHandler;
    window.contextMenuHandler = contextMenuHandler;
    window.mouseUpHandler = mouseUpHandler;
    window.beforeUnloadHandler = beforeUnloadHandler;
    window.mouseDetectionActive = mouseDetectionActive;

    // Add mouse listeners (capture phase)
    document.addEventListener('mousedown', mouseDetectionHandler, true);
    document.addEventListener('mouseup', mouseUpHandler, true);
    document.addEventListener('contextmenu', contextMenuHandler, true);
    window.addEventListener('beforeunload', beforeUnloadHandler, true);

    // Create keyboard event handler
    keyboardDetectionHandler = (event) =>
    {
      if (!keyboardDetectionActive) return;

      // Prevent default browser behavior
      event.preventDefault();
      event.stopPropagation();

      const code = event.code;
      const key = event.key;

      // Detect modifiers being held
      const modifiers = [];
      if (event.shiftKey) modifiers.push(event.location === 1 ? 'LSHIFT' : 'RSHIFT');
      if (event.ctrlKey) modifiers.push(event.location === 1 ? 'LCTRL' : 'RCTRL');
      if (event.altKey) modifiers.push(event.location === 1 ? 'LALT' : 'RALT');

      // Convert to Star Citizen format
      const scKey = convertKeyCodeToSC(code, key);

      // Skip if this is just a modifier key by itself - don't trigger detection for modifiers
      const isModifierKey = ['lshift', 'rshift', 'lctrl', 'rctrl', 'lalt', 'ralt', 'lwin'].includes(scKey);

      if (isModifierKey)
      {
        // Don't process modifier keys by themselves
        return;
      }

      // Build the input string (kb1_key format)
      const inputString = `kb1_${scKey}`;

      // Build display name
      const displayName = `Keyboard - ${code}`;

      // Create a synthetic event that matches the structure from Rust backend
      const syntheticResult = {
        input_string: inputString,
        display_name: displayName,
        device_type: 'Keyboard',
        axis_value: null,
        modifiers: modifiers,
        is_modifier: false
      };

      // Process this keyboard input through the same pipeline
      const processed = processInput(syntheticResult);

      if (processed && !allDetectedInputs.has(processed.scFormattedInput))
      {
        allDetectedInputs.set(processed.scFormattedInput, processed);

        if (allDetectedInputs.size === 1)
        {
          // First input detected - show it with confirm/cancel buttons
          statusEl.textContent = `Detected: ${processed.displayName}`;

          // Stop the main countdown timer
          if (countdownInterval)
          {
            console.log('[TIMER] [KEYBOARD] Clearing countdownInterval after first input, ID:', countdownInterval);
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          else
          {
            console.log('[TIMER] [KEYBOARD] countdownInterval already null!');
          }
          document.getElementById('binding-modal-countdown').textContent = '';

          // Create confirm/cancel UI
          const confirmUI = document.createElement('div');
          confirmUI.className = 'input-confirm-container';
          confirmUI.innerHTML = `
            <button class="btn btn-primary" id="confirm-single-input">✓ Use This Input</button>
            <div class="input-confirm-note">Or press another input within 1 second to choose...</div>
          `;
          statusEl.appendChild(confirmUI);

          // Confirm button handler
          document.getElementById('confirm-single-input').addEventListener('click', async () =>
          {
            // Mark detection as inactive to ignore any pending events
            isDetectionActive = false;

            // Clean up ALL timers and listeners
            if (keyboardCompletionTimeout)
            {
              clearTimeout(keyboardCompletionTimeout);
              keyboardCompletionTimeout = null;
            }
            if (countdownInterval)
            {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }
            keyboardDetectionActive = false;
            window.mouseDetectionActive = false;
            if (keyboardDetectionHandler)
            {
              document.removeEventListener('keydown', keyboardDetectionHandler, true);
              keyboardDetectionHandler = null;
            }
            if (mouseDetectionHandler)
            {
              document.removeEventListener('mousedown', mouseDetectionHandler, true);
              document.removeEventListener('mouseup', window.mouseUpHandler, true);
              document.removeEventListener('contextmenu', contextMenuHandler, true);
              window.removeEventListener('beforeunload', window.beforeUnloadHandler, true);
              mouseDetectionHandler = null;
            }
            if (window.currentInputDetectionUnlisten)
            {
              window.currentInputDetectionUnlisten();
              window.currentInputDetectionUnlisten = null;
            }
            if (window.currentCompletionUnlisten)
            {
              window.currentCompletionUnlisten();
              window.currentCompletionUnlisten = null;
            }

            const [, singleInput] = Array.from(allDetectedInputs.entries())[0];

            // Check for conflicts
            const conflicts = await invoke('find_conflicting_bindings', {
              input: singleInput.scFormattedInput,
              excludeActionMap: actionMapName,
              excludeAction: actionName
            });

            if (conflicts.length > 0)
            {
              window.pendingBinding = {
                actionMapName,
                actionName,
                mappedInput: singleInput.scFormattedInput,
                displayName: singleInput.displayName
              };
              showConflictModal(conflicts);
              return;
            }

            // No conflicts, proceed with binding
            await applyBinding(actionMapName, actionName, singleInput.scFormattedInput);
          });

          // Start a 1-second timer to auto-show selection UI if more inputs come
          if (keyboardCompletionTimeout) clearTimeout(keyboardCompletionTimeout);
          keyboardCompletionTimeout = setTimeout(() =>
          {
            // After 1 second with no more inputs, just leave the confirm UI showing
            keyboardCompletionTimeout = null;
          }, 1000);
        }
        else if (allDetectedInputs.size === 2)
        {
          // Second input detected - remove confirm UI and switch to selection UI
          if (keyboardCompletionTimeout)
          {
            clearTimeout(keyboardCompletionTimeout);
            keyboardCompletionTimeout = null;
          }

          // Stop the main countdown timer if still running
          if (countdownInterval)
          {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }

          // Clear any existing UI and show selection
          statusEl.innerHTML = '';
          statusEl.textContent = 'Multiple inputs detected - select one:';
          document.getElementById('binding-modal-countdown').textContent = '';

          selectionContainer = document.createElement('div');
          selectionContainer.className = 'input-selection-container';
          statusEl.appendChild(selectionContainer);

          // Add both inputs
          Array.from(allDetectedInputs.values()).forEach((input) =>
          {
            addDetectedInputButton(input);
          });
        }
        else
        {
          // More inputs - just add the new button
          addDetectedInputButton(processed);
        }
      }
    };

    // Add keyboard listener (capture phase)
    document.addEventListener('keydown', keyboardDetectionHandler, true);

    // Helper function to process a raw input result
    const processInput = (result) =>
    {
      console.log('INPUT DETECTED (raw):', result.display_name, result.input_string);

      // Apply joystick mapping if applicable
      const mappedInput = applyJoystickMapping(result.input_string);

      if (mappedInput === null)
      {
        return null; // Skip disabled joysticks
      }

      // Convert to Star Citizen format (handles axis naming)
      let scFormattedInput = toStarCitizenFormat(mappedInput);

      // Add modifier prefixes if any (lowercase to match AllBinds.xml format)
      if (result.modifiers && result.modifiers.length > 0)
      {
        const modifierOrder = ['LALT', 'RALT', 'LCTRL', 'RCTRL', 'LSHIFT', 'RSHIFT'];
        const sortedModifiers = result.modifiers
          .filter(mod => modifierOrder.includes(mod))
          .sort((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b))
          .map(mod => mod.toLowerCase());

        if (sortedModifiers.length > 0)
        {
          scFormattedInput = sortedModifiers.join('+') + '+' + scFormattedInput;
        }
      }

      // Update display name if mapping was applied
      let displayName = result.display_name;
      if (mappedInput !== result.input_string)
      {
        displayName = displayName.replace(/Joystick \d+/, (match) =>
        {
          const newJsNum = mappedInput.match(/^js(\d+)_/)[1];
          return `Joystick ${newJsNum}`;
        });
      }

      // Add modifiers to display name
      if (result.modifiers && result.modifiers.length > 0)
      {
        const modifierOrder = ['LALT', 'RALT', 'LCTRL', 'RCTRL', 'LSHIFT', 'RSHIFT'];
        const sortedModifiers = result.modifiers
          .filter(mod => modifierOrder.includes(mod))
          .sort((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b));

        if (sortedModifiers.length > 0)
        {
          displayName = sortedModifiers.join(' + ') + ' + ' + displayName;
        }
      }

      return {
        scFormattedInput,
        displayName,
        originalResult: result
      };
    };

    // Helper function to add a button to the selection UI
    const addDetectedInputButton = (processedInput) =>
    {
      if (!selectionContainer) return;

      const btn = document.createElement('button');
      btn.className = 'input-selection-btn';
      btn.innerHTML = `
        <span class="input-selection-icon">🎮</span>
        <span class="input-selection-name">${processedInput.displayName}</span>
      `;

      const inputKey = processedInput.scFormattedInput;

      btn.addEventListener('click', async () =>
      {
        const selectedInput = allDetectedInputs.get(inputKey);

        // Remove selection UI
        if (selectionContainer)
        {
          selectionContainer.remove();
          selectionContainer = null;
        }
        statusEl.textContent = `Selected: ${selectedInput.displayName}`;

        // Clear timer
        if (countdownInterval)
        {
          clearInterval(countdownInterval);
          countdownInterval = null;
        }

        // Unlisten from events
        if (window.currentInputDetectionUnlisten)
        {
          window.currentInputDetectionUnlisten();
          window.currentInputDetectionUnlisten = null;
        }
        if (window.currentCompletionUnlisten)
        {
          window.currentCompletionUnlisten();
          window.currentCompletionUnlisten = null;
        }

        // Cleanup keyboard detection
        if (keyboardDetectionHandler)
        {
          document.removeEventListener('keydown', keyboardDetectionHandler, true);
          keyboardDetectionHandler = null;
        }
        keyboardDetectionActive = false;

        // Check for conflicts
        const conflicts = await invoke('find_conflicting_bindings', {
          input: selectedInput.scFormattedInput,
          excludeActionMap: actionMapName,
          excludeAction: actionName
        });

        if (conflicts.length > 0)
        {
          window.pendingBinding = {
            actionMapName,
            actionName,
            mappedInput: selectedInput.scFormattedInput,
            displayName: selectedInput.displayName
          };
          showConflictModal(conflicts);
          return;
        }

        // No conflicts, apply binding
        await applyBinding(actionMapName, actionName, selectedInput.scFormattedInput);
      });

      selectionContainer.appendChild(btn);
    };

    // Listen for input-detected events (from joystick/backend)
    const unlistenInputs = await listen('input-detected', (event) =>
    {
      console.log('[TIMER] [EVENT] input-detected received, session_id:', event.payload.session_id, 'thisBindingId:', thisBindingId.toString());

      // Ignore if this event is from a previous binding attempt (check session ID)
      if (event.payload.session_id !== thisBindingId.toString())
      {
        console.log('[TIMER] [EVENT] Ignoring stale input-detected event (session ID mismatch)');
        return;
      }

      // Ignore if this event is from a previous binding attempt
      if (currentBindingId !== thisBindingId)
      {
        console.log('[TIMER] [EVENT] Ignoring stale input-detected event (binding ID mismatch)');
        return;
      }

      const result = event.payload;
      const processed = processInput(result);

      if (processed && !allDetectedInputs.has(processed.scFormattedInput))
      {
        allDetectedInputs.set(processed.scFormattedInput, processed);

        if (allDetectedInputs.size === 1)
        {
          // First input detected - show it with confirm/cancel buttons
          statusEl.textContent = `Detected: ${processed.displayName}`;

          // Stop the main countdown timer
          if (countdownInterval)
          {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          document.getElementById('binding-modal-countdown').textContent = '';

          // Create confirm/cancel UI
          const confirmUI = document.createElement('div');
          confirmUI.className = 'input-confirm-container';
          confirmUI.innerHTML = `
            <button class="btn btn-primary" id="confirm-single-input">\u2713 Use This Input</button>
            <div class="input-confirm-note">Or press another input within 1 second to choose...</div>
          `;
          statusEl.appendChild(confirmUI);

          // Confirm button handler
          document.getElementById('confirm-single-input').addEventListener('click', async () =>
          {
            // Mark detection as inactive to ignore any pending events
            isDetectionActive = false;

            // Clean up ALL timers and listeners
            if (keyboardCompletionTimeout)
            {
              clearTimeout(keyboardCompletionTimeout);
              keyboardCompletionTimeout = null;
            }
            if (countdownInterval)
            {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }
            keyboardDetectionActive = false;
            if (keyboardDetectionHandler)
            {
              document.removeEventListener('keydown', keyboardDetectionHandler, true);
              keyboardDetectionHandler = null;
            }
            if (window.currentInputDetectionUnlisten)
            {
              window.currentInputDetectionUnlisten();
              window.currentInputDetectionUnlisten = null;
            }
            if (window.currentCompletionUnlisten)
            {
              window.currentCompletionUnlisten();
              window.currentCompletionUnlisten = null;
            }

            const [, singleInput] = Array.from(allDetectedInputs.entries())[0];

            // Check for conflicts
            const conflicts = await invoke('find_conflicting_bindings', {
              input: singleInput.scFormattedInput,
              excludeActionMap: actionMapName,
              excludeAction: actionName
            });

            if (conflicts.length > 0)
            {
              window.pendingBinding = {
                actionMapName,
                actionName,
                mappedInput: singleInput.scFormattedInput,
                displayName: singleInput.displayName
              };
              showConflictModal(conflicts);
              return;
            }

            // No conflicts, proceed with binding
            await applyBinding(actionMapName, actionName, singleInput.scFormattedInput);
          });
        }
        else if (allDetectedInputs.size === 2)
        {
          // Second input detected - remove confirm UI and switch to selection UI
          if (keyboardCompletionTimeout)
          {
            clearTimeout(keyboardCompletionTimeout);
            keyboardCompletionTimeout = null;
          }

          // Stop the main countdown timer if still running
          if (countdownInterval)
          {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }

          // Clear any existing UI and show selection
          statusEl.innerHTML = '';
          statusEl.textContent = 'Multiple inputs detected - select one:';
          document.getElementById('binding-modal-countdown').textContent = '';

          selectionContainer = document.createElement('div');
          selectionContainer.className = 'input-selection-container';
          statusEl.appendChild(selectionContainer);

          // Add both inputs
          Array.from(allDetectedInputs.values()).forEach((input) =>
          {
            addDetectedInputButton(input);
          });
        }
        else
        {
          // More inputs - just add the new button
          addDetectedInputButton(processed);
        }
      }
    });

    // Store unlisten function for cleanup
    window.currentInputDetectionUnlisten = unlistenInputs;

    // Listen for completion event
    const unlistenCompletion = await listen('input-detection-complete', async (event) =>
    {
      console.log('[TIMER] [EVENT] input-detection-complete received, session_id:', event.payload?.session_id, 'thisBindingId:', thisBindingId.toString(), 'currentBindingId:', currentBindingId, 'isDetectionActive:', isDetectionActive);

      // Ignore if this event is from a previous binding attempt (check session ID)
      if (event.payload?.session_id !== thisBindingId.toString())
      {
        console.log('[TIMER] [EVENT] Ignoring stale input-detection-complete event (session ID mismatch)');
        return;
      }

      // Ignore if this event is from a previous binding attempt
      if (currentBindingId !== thisBindingId)
      {
        console.log('[TIMER] [EVENT] Ignoring stale input-detection-complete event (ID mismatch)');
        return;
      }      // Ignore if detection was already completed/cancelled
      if (!isDetectionActive)
      {
        console.log('[TIMER] [EVENT] Ignoring input-detection-complete, detection not active');
        return;
      }

      // Double-check the modal is still visible and we're still in binding mode
      const modal = document.getElementById('binding-modal');
      if (!modal || modal.style.display === 'none' || !bindingMode)
      {
        console.log('[TIMER] [EVENT] Ignoring input-detection-complete, modal not visible or not in binding mode');
        return;
      }

      console.log('[TIMER] [EVENT] Processing input-detection-complete event');      // Mark as inactive
      isDetectionActive = false;

      // Clear timer
      if (countdownInterval)
      {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }

      // Cleanup listeners
      if (window.currentInputDetectionUnlisten)
      {
        window.currentInputDetectionUnlisten();
        window.currentInputDetectionUnlisten = null;
      }
      if (window.currentCompletionUnlisten)
      {
        window.currentCompletionUnlisten();
        window.currentCompletionUnlisten = null;
      }

      // Cleanup keyboard detection
      if (keyboardDetectionHandler)
      {
        document.removeEventListener('keydown', keyboardDetectionHandler, true);
        keyboardDetectionHandler = null;
      }
      keyboardDetectionActive = false;

      // Cleanup mouse detection
      if (mouseDetectionHandler)
      {
        document.removeEventListener('mousedown', mouseDetectionHandler, true);
        document.removeEventListener('mouseup', window.mouseUpHandler, true);
        document.removeEventListener('contextmenu', contextMenuHandler, true);
        window.removeEventListener('beforeunload', window.beforeUnloadHandler, true);
        mouseDetectionHandler = null;
      }
      window.mouseDetectionActive = false;

      if (allDetectedInputs.size === 0)
      {
        // No input detected
        console.log('[TIMER] [EVENT] No inputs detected, showing timeout message');
        statusEl.textContent = 'No input detected - timed out';
        document.getElementById('binding-modal-countdown').textContent = '';

        // Store the binding ID to check it hasn't changed
        const timeoutBindingId = currentBindingId;
        setTimeout(() =>
        {
          // Only close if we're still on the same binding session
          if (currentBindingId === timeoutBindingId && bindingMode)
          {
            console.log('[TIMER] [EVENT] Closing modal after 2s timeout, binding ID match');
            closeBindingModal();
          }
          else
          {
            console.log('[TIMER] [EVENT] NOT closing modal - binding ID changed or modal already closed');
          }
        }, 2000);
        return;
      }

      // If inputs were detected, the confirm UI is already showing
      // Just cleanup timers and let user decide
      // Don't auto-apply anything
    });

    // Store unlisten function for cleanup
    window.currentCompletionUnlisten = unlistenCompletion;

    // Start event-based detection (doesn't return a value, just emits events)
    console.log('[TIMER] [RUST] Calling wait_for_inputs_with_events with bindingId:', thisBindingId);
    invoke('wait_for_inputs_with_events', {
      sessionId: thisBindingId.toString(),
      initialTimeoutSecs: countdown,
      collectDurationSecs: 2
    }).catch((error) =>
    {
      console.error('[TIMER] [RUST] Error during input detection:', error);

      // Cleanup listeners
      if (window.currentInputDetectionUnlisten)
      {
        window.currentInputDetectionUnlisten();
        window.currentInputDetectionUnlisten = null;
      }
      if (window.currentCompletionUnlisten)
      {
        window.currentCompletionUnlisten();
        window.currentCompletionUnlisten = null;
      }

      // Cleanup keyboard detection
      if (keyboardDetectionHandler)
      {
        document.removeEventListener('keydown', keyboardDetectionHandler, true);
        keyboardDetectionHandler = null;
      }
      keyboardDetectionActive = false;

      // Cleanup mouse detection
      if (window.mouseDetectionHandler)
      {
        document.removeEventListener('mousedown', window.mouseDetectionHandler, true);
        document.removeEventListener('mouseup', window.mouseUpHandler, true);
        document.removeEventListener('contextmenu', window.contextMenuHandler, true);
        window.removeEventListener('beforeunload', window.beforeUnloadHandler, true);
        window.mouseDetectionHandler = null;
        window.contextMenuHandler = null;
        window.mouseUpHandler = null;
        window.beforeUnloadHandler = null;
      }
      window.mouseDetectionActive = false;
    });
  } catch (error)
  {
    // Clear the timer in case of error
    if (countdownInterval)
    {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    console.error('Error waiting for input:', error);
    alert(`Error: ${error}`);
    closeBindingModal();
  }
}

function cancelBinding()
{
  closeBindingModal();
}

async function clearBinding()
{
  if (!currentBindingAction) return;

  try
  {
    await invoke('update_binding', {
      actionMapName: currentBindingAction.actionMapName,
      actionName: currentBindingAction.actionName,
      newInput: ''
    });

    // Mark as unsaved
    hasUnsavedChanges = true;
    updateUnsavedIndicator();

    await refreshBindings();
    closeBindingModal();
  } catch (error)
  {
    console.error('Error clearing binding:', error);
    alert(`Error: ${error}`);
  }
}

function closeBindingModal()
{
  console.log('[TIMER] closeBindingModal called');
  // Mark detection as inactive to ignore any pending events
  isDetectionActive = false;

  // Clear the countdown interval if it's running
  if (countdownInterval)
  {
    console.log('[TIMER] Clearing countdownInterval in closeBindingModal, ID:', countdownInterval);
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  else
  {
    console.log('[TIMER] No countdownInterval to clear in closeBindingModal');
  }

  // Clear keyboard completion timeout
  if (keyboardCompletionTimeout)
  {
    console.log('[TIMER] Clearing keyboardCompletionTimeout in closeBindingModal');
    clearTimeout(keyboardCompletionTimeout);
    keyboardCompletionTimeout = null;
  }
  else
  {
    console.log('[TIMER] No keyboardCompletionTimeout to clear in closeBindingModal');
  }

  // Cleanup keyboard detection
  if (keyboardDetectionHandler)
  {
    document.removeEventListener('keydown', keyboardDetectionHandler, true);
    keyboardDetectionHandler = null;
  }
  keyboardDetectionActive = false;

  // Cleanup mouse detection
  if (window.mouseDetectionHandler)
  {
    document.removeEventListener('mousedown', window.mouseDetectionHandler, true);
    document.removeEventListener('mouseup', window.mouseUpHandler, true);
    document.removeEventListener('contextmenu', window.contextMenuHandler, true);
    window.removeEventListener('beforeunload', window.beforeUnloadHandler, true);
    window.mouseDetectionHandler = null;
    window.contextMenuHandler = null;
    window.mouseUpHandler = null;
    window.beforeUnloadHandler = null;
  }
  if (window.mouseDetectionActive !== undefined)
  {
    window.mouseDetectionActive = false;
  }

  // Cleanup event listeners
  if (window.currentInputDetectionUnlisten)
  {
    console.log('[TIMER] Calling currentInputDetectionUnlisten');
    window.currentInputDetectionUnlisten();
    window.currentInputDetectionUnlisten = null;
  }
  else
  {
    console.log('[TIMER] No currentInputDetectionUnlisten to call');
  }
  if (window.currentCompletionUnlisten)
  {
    console.log('[TIMER] Calling currentCompletionUnlisten');
    window.currentCompletionUnlisten();
    window.currentCompletionUnlisten = null;
  }
  else
  {
    console.log('[TIMER] No currentCompletionUnlisten to call');
  }

  bindingMode = false;
  currentBindingAction = null;
  document.getElementById('binding-modal').style.display = 'none';
}

async function refreshBindings()
{
  try
  {
    console.log('Refreshing bindings from backend...');
    currentKeybindings = await invoke('get_merged_bindings');
    console.log('Got merged bindings with', currentKeybindings.action_maps?.length, 'action maps');

    // Update working copy with latest changes
    if (currentKeybindings)
    {
      localStorage.setItem('workingBindings', JSON.stringify(currentKeybindings));
      localStorage.setItem('hasUnsavedChanges', hasUnsavedChanges.toString());
      console.log('Updated workingBindings in localStorage');
    }

    renderKeybindings();
  } catch (error)
  {
    console.error('Error refreshing bindings:', error);
  }
}

// Make startBinding available globally
window.startBinding = startBinding;

// Function to remove a specific binding
window.removeBinding = async function (actionMapName, actionName, inputToClear)
{
  console.log('removeBinding called with:', { actionMapName, actionName, inputToClear });

  // Show custom confirmation dialog BEFORE doing anything
  const confirmed = await showConfirmation(
    'Clear this binding?',
    'Clear Binding',
    'Clear',
    'Cancel'
  );

  // If user cancelled, stop immediately
  if (!confirmed)
  {
    console.log('User cancelled binding removal');
    return;
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
    hasUnsavedChanges = true;
    updateUnsavedIndicator();

    // Refresh bindings
    await refreshBindings();

  } catch (error)
  {
    console.error('Error removing binding:', error);
    alert(`Error: ${error}`);
  }
};

function updateUnsavedIndicator()
{
  const indicator = document.getElementById('loaded-file-indicator');
  const fileNameEl = document.getElementById('loaded-file-name');

  if (indicator && fileNameEl)
  {
    if (hasUnsavedChanges)
    {
      indicator.style.borderColor = 'var(--accent-primary)';
      indicator.style.backgroundColor = 'rgba(217, 83, 79, 0.1)';
      if (!fileNameEl.textContent.includes('*'))
      {
        fileNameEl.textContent += ' *';
      }
    }
    else
    {
      indicator.style.borderColor = 'var(--button-border)';
      indicator.style.backgroundColor = 'var(--bg-medium)';
      fileNameEl.textContent = fileNameEl.textContent.replace(' *', '');
    }
  }
}

// ============================================================================
// JOYSTICK MAPPING FUNCTIONS
// ============================================================================

let detectedJoysticks = [];

// JOYSTICK MAPPING
// ============================================================================

let currentDetectingDevice = null; // 'js1', 'js2', or 'gp1'
let deviceDetectionSessionId = null;
let deviceMappings = {}; // Stores { js1: { detectedNum: 3, detectedPrefix: 'js', deviceName: 'VKB' }, ... }

async function openJoystickMappingModal()
{
  const modal = document.getElementById('joystick-mapping-modal');
  modal.style.display = 'flex';

  // Load existing mappings and update display
  loadDeviceMappings();
  updateDeviceInfoDisplays();
}

function closeJoystickMappingModal()
{
  const modal = document.getElementById('joystick-mapping-modal');
  modal.style.display = 'none';

  // Stop any active detection
  if (currentDetectingDevice !== null)
  {
    stopDeviceDetection();
  }
}

function loadDeviceMappings()
{
  const saved = localStorage.getItem('joystickMapping');
  if (saved)
  {
    try
    {
      deviceMappings = JSON.parse(saved);
    }
    catch (e)
    {
      console.error('Failed to parse saved joystick mapping:', e);
      deviceMappings = {};
    }
  }
}

async function detectDevice(targetDevice)
{
  // If already detecting this device, stop it
  if (currentDetectingDevice === targetDevice)
  {
    stopDeviceDetection();
    return;
  }

  // Stop any other detection first
  if (currentDetectingDevice !== null)
  {
    stopDeviceDetection();
  }

  currentDetectingDevice = targetDevice;
  const buttonId = `detect-${targetDevice}-btn`;
  const infoId = `${targetDevice}-info`;

  const button = document.getElementById(buttonId);
  const infoDiv = document.getElementById(infoId);

  // Update UI to detecting state
  if (button)
  {
    button.textContent = '⏹️ Stop Detecting';
    button.classList.add('detecting');
  }

  if (infoDiv)
  {
    infoDiv.classList.add('detecting');
    infoDiv.innerHTML = '<div style="color: #ffc107; font-weight: 500;">👂 Listening... Press any button on your device!</div>';
  }

  // Generate session ID
  deviceDetectionSessionId = 'device-detect-' + Date.now();
  const sessionId = deviceDetectionSessionId;

  try
  {
    console.log(`[DEVICE-DETECTION] Detecting ${targetDevice}, session:`, sessionId);

    const result = await invoke('wait_for_input_binding', {
      sessionId: sessionId,
      timeoutSecs: 15
    });

    // Check if this session is still active
    if (deviceDetectionSessionId !== sessionId)
    {
      console.log(`[DEVICE-DETECTION] Session ${sessionId} cancelled, ignoring result`);
      return;
    }

    if (result)
    {
      console.log(`[DEVICE-DETECTION] Detected input:`, result);

      // Extract js/gp number and device info
      const match = result.input_string.match(/^(js|gp)(\d+)_/);
      if (match)
      {
        const prefix = match[1];
        const detectedNum = parseInt(match[2]);

        // Get device name from result
        const deviceName = result.display_name || `Device ${detectedNum}`;

        // Store the mapping
        deviceMappings[targetDevice] = {
          detectedNum: detectedNum,
          detectedPrefix: prefix,
          deviceName: deviceName
        };

        console.log(`[DEVICE-DETECTION] Mapped ${targetDevice}: ${prefix}${detectedNum}`);

        // Update display
        if (infoDiv)
        {
          infoDiv.classList.remove('detecting');
          infoDiv.classList.add('configured');
          infoDiv.innerHTML = `
            <div class="device-name">${deviceName}</div>
            <div class="device-details">Detected as: ${prefix}${detectedNum}</div>
            <div class="device-mapping">Maps to: ${targetDevice}</div>
          `;
        }
      }
    }
    else
    {
      // Timeout
      if (infoDiv)
      {
        infoDiv.classList.remove('detecting');
        infoDiv.innerHTML = '<div style="color: #d9534f;">⏱️ Timeout - no input detected. Try again.</div>';

        setTimeout(() =>
        {
          updateDeviceInfoDisplays();
        }, 3000);
      }
    }
  }
  catch (error)
  {
    console.error('[DEVICE-DETECTION] Error:', error);
    if (infoDiv)
    {
      infoDiv.classList.remove('detecting');
      infoDiv.innerHTML = `<div style="color: #d9534f;">❌ Error: ${error.message || error}</div>`;

      setTimeout(() =>
      {
        updateDeviceInfoDisplays();
      }, 3000);
    }
  }
  finally
  {
    // Reset button
    if (button)
    {
      const btn = document.getElementById(buttonId);
      if (btn)
      {
        btn.textContent = `🎮 Detect ${targetDevice}`;
        btn.classList.remove('detecting');
      }
    }

    if (currentDetectingDevice === targetDevice)
    {
      currentDetectingDevice = null;
    }
    deviceDetectionSessionId = null;
  }
}

function stopDeviceDetection()
{
  if (currentDetectingDevice === null) return;

  console.log(`[DEVICE-DETECTION] Stopping detection for ${currentDetectingDevice}`);

  const buttonId = `detect-${currentDetectingDevice}-btn`;
  const button = document.getElementById(buttonId);

  if (button)
  {
    button.textContent = `🎮 Detect ${currentDetectingDevice}`;
    button.classList.remove('detecting');
  }

  updateDeviceInfoDisplays();

  currentDetectingDevice = null;
  deviceDetectionSessionId = null;
}

function updateDeviceInfoDisplays()
{
  // Update all device info displays
  ['js1', 'js2', 'gp1'].forEach(device =>
  {
    const infoDiv = document.getElementById(`${device}-info`);
    if (!infoDiv) return;

    const mapping = deviceMappings[device];
    if (mapping && mapping.detectedNum)
    {
      infoDiv.classList.add('configured');
      infoDiv.classList.remove('detecting');
      infoDiv.innerHTML = `
        <div class="device-name">${mapping.deviceName}</div>
        <div class="device-details">Detected as: ${mapping.detectedPrefix}${mapping.detectedNum}</div>
        <div class="device-mapping">Maps to: ${device}</div>
      `;
    }
    else
    {
      infoDiv.classList.remove('configured', 'detecting');
      infoDiv.innerHTML = '<div class="not-configured">Not configured</div>';
    }
  });
}

function saveJoystickMapping()
{
  // Save the device mappings
  localStorage.setItem('joystickMapping', JSON.stringify(deviceMappings));
  console.log('Saved joystick mapping:', deviceMappings);

  closeJoystickMappingModal();
}

// Function to apply joystick mapping to detected input
function applyJoystickMapping(detectedInput)
{
  const mappings = JSON.parse(localStorage.getItem('joystickMapping') || '{}');

  // Extract the prefix and number from the detected input (e.g., "js3_button1" -> js, 3)
  const match = detectedInput.match(/^(js|gp)(\d+)_/);
  if (!match)
  {
    return detectedInput; // No device number found, return as-is
  }

  const detectedPrefix = match[1];
  const detectedNum = parseInt(match[2]);

  // Find which target device (js1, js2, gp1) maps to this detected device
  for (const [targetDevice, mapping] of Object.entries(mappings))
  {
    if (mapping.detectedPrefix === detectedPrefix && mapping.detectedNum === detectedNum)
    {
      // Found a mapping - replace the device prefix and number
      const mappedInput = detectedInput.replace(/^(js|gp)\d+_/, `${targetDevice}_`);
      console.log(`Applied joystick mapping: ${detectedInput} -> ${mappedInput}`);
      return mappedInput;
    }
  }

  // No mapping found, return as-is
  console.log(`No mapping found for ${detectedInput}, using as-is`);
  return detectedInput;
}

// ============================================================================
// JOYSTICK TEST DETECTION
// ============================================================================

let testingJoystickNum = null;
let testTimeout = null;

async function startJoystickTest(detectedScNum, devicePrefix)
{
  if (testingJoystickNum !== null)
  {
    // Stop current test
    stopJoystickTest();
    return;
  }

  console.log(`Starting test for ${devicePrefix}${detectedScNum}`);
  testingJoystickNum = detectedScNum;

  const btn = document.querySelector(`.joystick-test-btn[data-detected-sc-num="${detectedScNum}"][data-device-prefix="${devicePrefix}"]`);
  const indicator = document.getElementById(`test-indicator-${devicePrefix}${detectedScNum}`);

  btn.textContent = 'Stop';
  btn.classList.add('active');
  indicator.textContent = '👂 Listening for input... Press any button!';

  // Start listening for input
  try
  {
    const sessionId = 'keybinding-test-' + Date.now();
    const result = await invoke('wait_for_input_binding', {
      sessionId: sessionId,
      timeoutSecs: 10
    });

    if (result && result.input_string.startsWith(`${devicePrefix}${detectedScNum}_`))
    {
      // Detected input from this device!
      indicator.textContent = `✅ Detected: ${result.display_name}`;
      indicator.classList.add('detected');

      // Reset after 2 seconds
      setTimeout(() =>
      {
        stopJoystickTest(devicePrefix, detectedScNum);
      }, 2000);
    } else if (result)
    {
      // Input detected but from wrong device
      const match = result.input_string.match(/^(gp|js)(\d+)_/);
      if (match)
      {
        const detectedPrefix = match[1];
        const detectedNum = match[2];
        indicator.textContent = `❌ Detected input from ${detectedPrefix}${detectedNum}, not ${devicePrefix}${detectedScNum}`;
      } else
      {
        indicator.textContent = `❌ Detected input from different device`;
      }
      setTimeout(() =>
      {
        stopJoystickTest(devicePrefix, detectedScNum);
      }, 2000);
    } else
    {
      // Timeout
      indicator.textContent = `⏱️ No input detected`;
      setTimeout(() =>
      {
        stopJoystickTest(devicePrefix, detectedScNum);
      }, 1500);
    }
  } catch (error)
  {
    console.error('Error during joystick test:', error);
    indicator.textContent = `❌ Error: ${error}`;
    setTimeout(() =>
    {
      stopJoystickTest(devicePrefix, detectedScNum);
    }, 2000);
  }
}

function stopJoystickTest(devicePrefix = null, detectedScNum = null)
{
  if (testingJoystickNum === null) return;

  if (!devicePrefix || !detectedScNum)
  {
    // If not provided, find from testingJoystickNum (for backwards compatibility)
    detectedScNum = testingJoystickNum;
    devicePrefix = 'js'; // Default
  }

  const btn = document.querySelector(`.joystick-test-btn[data-detected-sc-num="${detectedScNum}"][data-device-prefix="${devicePrefix}"]`);
  const indicator = document.getElementById(`test-indicator-${devicePrefix}${detectedScNum}`);

  if (btn)
  {
    btn.textContent = 'Test';
    btn.classList.remove('active');
  }
  if (indicator)
  {
    indicator.classList.remove('detected');
    indicator.textContent = 'Press a button on this device to identify it...';
  }

  testingJoystickNum = null;

  if (testTimeout)
  {
    clearTimeout(testTimeout);
    testTimeout = null;
  }
}

// ============================================================================
// CONFLICT MODAL FUNCTIONS
// ============================================================================

function showConflictModal(conflicts)
{
  const modal = document.getElementById('conflict-modal');
  const conflictList = document.getElementById('conflict-list');

  // Populate conflict list
  conflictList.innerHTML = conflicts.map(c =>
  {
    // Handle localization keys that start with @ - use the action name as fallback
    const actionLabel = (c.action_label && !c.action_label.startsWith('@'))
      ? c.action_label
      : formatDisplayName(c.action_name);

    const mapLabel = (c.action_map_label && !c.action_map_label.startsWith('@'))
      ? c.action_map_label
      : formatDisplayName(c.action_map_name);

    return `
      <div class="conflict-item">
        <div class="conflict-action-label">${actionLabel}</div>
        <div class="conflict-map-label">${mapLabel}</div>
      </div>
    `;
  }).join('');

  modal.style.display = 'flex';
}

// Helper function to format display names (converts snake_case to Title Case)
function formatDisplayName(name)
{
  if (!name) return '';

  // Remove common prefixes
  let cleaned = name
    .replace(/^v_/, '')
    .replace(/^pc_/, '')
    .replace(/^ui_/, '')
    .replace(/^spectate_/, '');

  // Split on underscores and capitalize each word
  return cleaned
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function closeConflictModal()
{
  const modal = document.getElementById('conflict-modal');
  modal.style.display = 'none';

  // Clear pending binding
  window.pendingBinding = null;

  // Update binding modal status
  document.getElementById('binding-modal-status').textContent = 'Binding cancelled';

  setTimeout(() =>
  {
    closeBindingModal();
  }, 1000);
}

async function confirmConflictBinding()
{
  const modal = document.getElementById('conflict-modal');
  modal.style.display = 'none';

  if (window.pendingBinding)
  {
    const { actionMapName, actionName, mappedInput } = window.pendingBinding;
    await applyBinding(actionMapName, actionName, mappedInput);
    window.pendingBinding = null;
  }
}

async function applyBinding(actionMapName, actionName, mappedInput)
{
  console.log('Calling update_binding...');
  // Update the binding in backend
  await invoke('update_binding', {
    actionMapName: actionMapName,
    actionName: actionName,
    newInput: mappedInput
  });
  console.log('update_binding completed');

  // Mark as unsaved
  hasUnsavedChanges = true;
  updateUnsavedIndicator();

  // Immediately refresh and save to localStorage
  console.log('Binding updated, refreshing data...');
  await refreshBindings();
  console.log('Bindings refreshed and saved to localStorage');

  // Close modal after a short delay
  setTimeout(() =>
  {
    closeBindingModal();
  }, 1000);
}

async function resetBinding()
{
  if (!currentBindingAction) return;

  try
  {
    const actionMapName = currentBindingAction.actionMapName;
    const actionName = currentBindingAction.actionName;

    // Call backend to reset binding (remove customization)
    // This will cause the action to use defaults from AllBinds again
    await invoke('reset_binding', {
      actionMapName: actionMapName,
      actionName: actionName
    });

    // Mark as unsaved
    hasUnsavedChanges = true;
    updateUnsavedIndicator();

    // Refresh to show default bindings
    await refreshBindings();
    closeBindingModal();
  } catch (error)
  {
    console.error('Error resetting binding:', error);
    // Fallback to old method if reset_binding doesn't exist
    if (error.toString().includes('not found'))
    {
      console.log('Using fallback reset method');
      await fallbackResetBinding();
    } else
    {
      alert(`Error: ${error}`);
    }
  }
}

// Fallback method for reset if backend doesn't have reset_binding command yet
async function fallbackResetBinding()
{
  if (!currentBindingAction) return;

  try
  {
    const actionMapName = currentBindingAction.actionMapName;
    const actionName = currentBindingAction.actionName;

    // Clear the binding by setting empty input
    await invoke('update_binding', {
      actionMapName: actionMapName,
      actionName: actionName,
      newInput: ''
    });

    hasUnsavedChanges = true;
    updateUnsavedIndicator();
    await refreshBindings();
    closeBindingModal();
  } catch (error)
  {
    console.error('Error in fallback reset:', error);
    alert(`Error: ${error}`);
  }
}

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
// INITIALIZE LOG FILE PATH
// =====================
(async () =>
{
  try
  {
    const logPath = await invoke('get_log_file_path');
    const logPathElement = document.getElementById('debug-log-path');

    if (logPathElement)
    {
      logPathElement.title = `Log file: ${logPath}\nClick to copy path`;
      logPathElement.addEventListener('click', async () =>
      {
        try
        {
          await navigator.clipboard.writeText(logPath);
          const originalText = logPathElement.textContent;
          logPathElement.textContent = '✓ Copied!';
          setTimeout(() =>
          {
            logPathElement.textContent = originalText;
          }, 2000);
        } catch (e)
        {
          console.error('Failed to copy to clipboard:', e);
          alert(`Log file path:\n${logPath}`);
        }
      });

      await logInfo(`Application started - version ${await invoke('get_app_version')}`);
    }
  } catch (error)
  {
    console.error('Failed to get log file path:', error);
  }
})();
