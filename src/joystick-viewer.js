const { invoke } = window.__TAURI__.core;
const { open, save } = window.__TAURI__.dialog;

// Import shared rendering utilities
import
{
    ButtonFrameWidth,
    ButtonFrameHeight,
    HatFrameWidth,
    HatFrameHeight,
    HatSpacing,
    simplifyButtonName,
    drawConnectingLine,
    drawButtonMarker,
    drawButtonBox,
    getHat4WayPositions,
    drawHat4WayBoxes,
    roundRect
} from './button-renderer.js';
import { toStarCitizenFormat } from './input-utils.js';

// ========================================
// State Management
// ========================================

// Template and bindings
let currentTemplate = null;
let currentBindings = null;

// Canvas elements
let canvas, ctx;

// UI state
let selectedButton = null;
let selectedBox = null; // Track the currently selected/clicked box for highlighting
let clickableBoxes = []; // Track clickable binding boxes for mouse events

// View transform
let zoom = 1.0;
let pan = { x: 0, y: 0 };
let isPanning = false;
let lastPanPosition = { x: 0, y: 0 };

// Filter state
let currentPageIndex = 0; // Currently viewing page index
let hideDefaultBindings = false; // Filter to hide default bindings
let modifierFilter = 'all'; // Current modifier filter: 'all', 'lalt', 'lctrl', etc.

// Export bounds tracking
let drawBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

// ========================================
// Constants
// ========================================

// Drawing modes
const DrawMode = {
    NORMAL: 'normal',
    EXPORT: 'export',
    BOUNDS_ONLY: 'bounds_only'
};

// ========================================
// Utility Functions
// ========================================

// Helper to get current joystick number
function getCurrentJoystickNumber()
{
    if (!currentTemplate) return 1;

    // New pages structure
    if (currentTemplate.pages && currentTemplate.pages[currentPageIndex])
    {
        return currentTemplate.pages[currentPageIndex].joystickNumber || 1;
    }

    // Fallback for legacy structure
    const currentStickData = currentPageIndex === 0 ? currentTemplate.leftStick : currentTemplate.rightStick;
    return (currentStickData && currentStickData.joystickNumber) || currentTemplate.joystickNumber || 1;
}

function normalizeInputStringForStick(rawInput, jsPrefix)
{
    if (!rawInput || typeof rawInput !== 'string')
    {
        return null;
    }

    const trimmed = rawInput.trim();
    if (!trimmed)
    {
        return null;
    }

    let normalized = trimmed.toLowerCase();

    // Convert to SC axis naming when possible
    const scFormat = toStarCitizenFormat(normalized);
    if (scFormat && typeof scFormat === 'string')
    {
        normalized = scFormat.toLowerCase();
    }

    if (jsPrefix)
    {
        if (normalized.match(/^(js|gp)\d+_/))
        {
            normalized = normalized.replace(/^(js|gp)\d+_/, jsPrefix);
        }
        else if (normalized.startsWith('axis') || normalized.startsWith('button'))
        {
            normalized = `${jsPrefix}${normalized}`;
        }
    }

    return normalized;
}

// Normalize template data to current format (handles legacy formats)
function normalizeTemplateData(templateData)
{
    // Handle old format: convert buttons array to rightStick
    if (templateData.buttons && !templateData.rightStick)
    {
        templateData.rightStick = { joystickNumber: 2, buttons: templateData.buttons };
        templateData.leftStick = { joystickNumber: 1, buttons: [] };
    }
    // Ensure nested structure has buttons array
    else if (templateData.leftStick || templateData.rightStick)
    {
        if (templateData.leftStick && typeof templateData.leftStick === 'object' &&
            !Array.isArray(templateData.leftStick) && !templateData.leftStick.buttons)
        {
            templateData.leftStick.buttons = [];
        }
        if (templateData.rightStick && typeof templateData.rightStick === 'object' &&
            !Array.isArray(templateData.rightStick) && !templateData.rightStick.buttons)
        {
            templateData.rightStick.buttons = [];
        }
    }

    // Handle old imageFlipped boolean format
    if (typeof templateData.imageFlipped === 'boolean')
    {
        templateData.imageFlipped = templateData.imageFlipped ? 'left' : 'right';
    }

    return templateData;
}

// ========================================
// Initialization
// ========================================

// Export initialization function for tab system
window.initializeVisualView = function ()
{
    if (canvas) return; // Already initialized

    canvas = document.getElementById('viewer-canvas');
    ctx = canvas.getContext('2d');

    initializeEventListeners();
    loadCurrentBindings();
    restoreViewState();
    loadPersistedTemplate();

    // Set up resize listener
    window.addEventListener('resize', resizeViewerCanvas);

    // Listen for page visibility changes to refresh bindings when returning
    document.addEventListener('visibilitychange', async () =>
    {
        if (!document.hidden)
        {
            console.log('Page became visible, refreshing bindings...');
            // Page is now visible - reload bindings in case they changed
            await loadCurrentBindings();
            console.log('Bindings reloaded, action maps:', currentBindings?.action_maps?.length);
            if (currentTemplate && window.viewerImage)
            {
                console.log('Redrawing canvas with updated bindings');
                centerViewOnImage();
                resizeViewerCanvas();
                drawButtons(window.viewerImage);
            }
            else
            {
                console.log('Template or image not loaded yet');
            }
        }
    });
};

function initializeEventListeners()
{
    // Page selector buttons - will be populated dynamically when template loads
    const pageSelectorContainer = document.getElementById('viewer-stick-selector');
    if (pageSelectorContainer)
    {
        pageSelectorContainer.addEventListener('click', (e) =>
        {
            const btn = e.target.closest('[data-page-index]');
            if (btn)
            {
                const pageIndex = parseInt(btn.dataset.pageIndex, 10);
                switchPage(pageIndex);
            }
        });
    }

    // Tab key to navigate pages
    document.addEventListener('keydown', (e) =>
    {
        if (e.key === 'Tab' && currentTemplate && currentTemplate.pages)
        {
            e.preventDefault(); // Prevent default tab focus behavior
            const maxPages = currentTemplate.pages.length;
            if (maxPages > 1)
            {
                const direction = e.shiftKey ? -1 : 1; // Shift+Tab goes back, Tab goes forward
                const nextPageIndex = (currentPageIndex + direction + maxPages) % maxPages;
                switchPage(nextPageIndex);
            }
        }
    });

    // Hide defaults toggle button
    const hideDefaultsBtn = document.getElementById('hide-defaults-toggle');
    if (hideDefaultsBtn)
    {
        hideDefaultsBtn.addEventListener('click', () =>
        {
            hideDefaultBindings = !hideDefaultBindings;
            updateHideDefaultsButton();
            // Save preference
            ViewerState.saveViewState();
            // Redraw canvas
            if (window.viewerImage)
            {
                resizeViewerCanvas();
            }
        });
    }

    // Modifier filter radios
    document.querySelectorAll('input[name="modifier-filter"]').forEach(radio =>
    {
        radio.addEventListener('change', (e) =>
        {
            modifierFilter = e.target.value;
            // Save preference
            ViewerState.saveViewState();
            // Redraw canvas
            if (window.viewerImage)
            {
                resizeViewerCanvas();
            }
        });
    });

    const selectTemplateBtn = document.getElementById('select-template-btn');
    if (selectTemplateBtn) selectTemplateBtn.addEventListener('click', openTemplateModal);

    const welcomeSelectBtn = document.getElementById('welcome-select-btn');
    if (welcomeSelectBtn) welcomeSelectBtn.addEventListener('click', openTemplateModal);

    const exportImageBtn = document.getElementById('export-image-btn');
    if (exportImageBtn) exportImageBtn.addEventListener('click', exportToImage);

    // Modal
    const templateModalCancel = document.getElementById('template-modal-cancel');
    if (templateModalCancel) templateModalCancel.addEventListener('click', closeTemplateModal);

    // File input
    const templateFileInput = document.getElementById('template-file-input');
    if (templateFileInput) templateFileInput.addEventListener('change', onTemplateFileSelected);

    // Canvas click for selecting bindings
    if (canvas)
    {
        canvas.addEventListener('click', onCanvasClick);
        canvas.addEventListener('mousemove', onCanvasMouseMove);
        canvas.addEventListener('mousedown', onCanvasMouseDown);
        canvas.addEventListener('mouseup', onCanvasMouseUp);
        canvas.addEventListener('contextmenu', onCanvasContextMenu);
        canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    }
}

async function loadCurrentBindings()
{
    try
    {
        // Always get fresh merged bindings from backend (AllBinds + user customizations)
        // No need to cache - backend is the single source of truth
        console.log('Loading bindings from backend');
        currentBindings = await invoke('get_merged_bindings');
        console.log('Loaded bindings from backend with', currentBindings.action_maps?.length, 'action maps');
    } catch (error)
    {
        console.log('Error loading merged bindings:', error);
        currentBindings = null;
    }
}

// Refresh visual view bindings when switching back to this tab
window.refreshVisualView = async function ()
{
    try
    {
        await loadCurrentBindings();
        // Redraw canvas if template is loaded
        if (window.viewerImage && currentTemplate)
        {
            centerViewOnImage();
            resizeViewerCanvas();
        }
    } catch (error)
    {
        console.error('Error refreshing visual view:', error);
    }
};

// Template selection
async function openTemplateModal()
{
    // For now, just open file dialog
    // In the future, we could maintain a library of templates
    document.getElementById('template-file-input').click();
}

function closeTemplateModal()
{
    document.getElementById('template-modal').style.display = 'none';
}

async function onTemplateFileSelected(e)
{
    const file = e.target.files[0];
    if (!file) return;

    try
    {
        const text = await file.text();
        const templateData = normalizeTemplateData(JSON.parse(text));

        currentTemplate = templateData;

        // Persist to localStorage
        ViewerState.saveTemplate(templateData, file.name);

        // Update header template name
        console.log('onTemplateFileSelected - templateData.name:', templateData.name);
        console.log('window.updateTemplateIndicator exists:', typeof window.updateTemplateIndicator);
        if (window.updateTemplateIndicator)
        {
            console.log('Calling updateTemplateIndicator with:', templateData.name, file.name);
            window.updateTemplateIndicator(templateData.name, file.name);
        }
        else
        {
            console.log('window.updateTemplateIndicator is not available');
        }

        displayTemplate();

    } catch (error)
    {
        console.error('Error loading template:', error);
        await window.showAlert(`Failed to load template: ${error}`, 'Error');
    }

    // Clear the input
    e.target.value = '';
}

function restoreViewState()
{
    try
    {
        // Restore current page index
        const savedPageIndex = localStorage.getItem('viewerCurrentPageIndex');
        if (savedPageIndex !== null)
        {
            currentPageIndex = parseInt(savedPageIndex, 10) || 0;
        }

        // Restore hide defaults preference
        const savedHideDefaults = localStorage.getItem('hideDefaultBindings');
        if (savedHideDefaults !== null)
        {
            hideDefaultBindings = savedHideDefaults === 'true';
            updateHideDefaultsButton();
        }

        // Restore modifier filter preference
        const savedModifierFilter = localStorage.getItem('modifierFilter');
        if (savedModifierFilter)
        {
            modifierFilter = savedModifierFilter;
            const radio = document.querySelector(`input[name="modifier-filter"][value="${savedModifierFilter}"]`);
            if (radio)
            {
                radio.checked = true;
            }
        }

        // Restore pan and zoom using ViewerState helper
        const savedPan = ViewerState.load('viewerPan');
        const savedZoom = localStorage.getItem('viewerZoom');

        if (savedPan)
        {
            pan.x = savedPan.x || 0;
            pan.y = savedPan.y || 0;
        }

        if (savedZoom)
        {
            zoom = parseFloat(savedZoom);
            if (isNaN(zoom) || zoom < 0.1 || zoom > 5)
            {
                zoom = 1.0; // Reset to default if invalid
            }
        }
    }
    catch (error)
    {
        console.error('Error restoring view state:', error);
    }
}

function updateHideDefaultsButton()
{
    const btn = document.getElementById('hide-defaults-toggle');
    if (btn)
    {
        if (hideDefaultBindings)
        {
            btn.classList.add('active');
            btn.querySelector('span:not(.control-icon)').textContent = 'Custom Only';
        }
        else
        {
            btn.classList.remove('active');
            btn.querySelector('span:not(.control-icon)').textContent = 'Show All';
        }
    }
}

function centerViewOnImage()
{
    if (!window.viewerImage || !canvas) return;

    const container = document.getElementById('viewer-canvas-container');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const containerCenterX = rect.width / 2;
    const containerCenterY = rect.height / 2;

    const imageCenterX = window.viewerImage.width / 2;
    const imageCenterY = window.viewerImage.height / 2;

    pan.x = containerCenterX - (imageCenterX * zoom);
    pan.y = containerCenterY - (imageCenterY * zoom);

    ViewerState.saveViewState();
}

function loadPersistedTemplate()
{
    try
    {
        const savedTemplate = ViewerState.load('currentTemplate');
        if (savedTemplate)
        {
            currentTemplate = normalizeTemplateData(savedTemplate);

            // Validate currentPageIndex against available pages
            let maxPages = 0;
            if (currentTemplate.pages && currentTemplate.pages.length > 0)
            {
                maxPages = currentTemplate.pages.length;
            }
            else if (currentTemplate.leftStick || currentTemplate.rightStick)
            {
                maxPages = 2; // Legacy dual-stick
            }

            if (currentPageIndex >= maxPages)
            {
                currentPageIndex = 0;
            }

            // Update header template name
            const savedFileName = localStorage.getItem('templateFileName');
            if (window.updateTemplateIndicator)
            {
                window.updateTemplateIndicator(currentTemplate.name, savedFileName);
            }

            displayTemplate();
        }
    } catch (error)
    {
        console.error('Error loading persisted template:', error);
    }
}

// Page switching
function switchPage(pageIndex)
{
    if (!currentTemplate || !currentTemplate.pages || pageIndex < 0 || pageIndex >= currentTemplate.pages.length)
    {
        return;
    }

    if (currentPageIndex === pageIndex) return;

    currentPageIndex = pageIndex;

    // Save to localStorage
    ViewerState.saveViewState();

    // Update button states
    updatePageSelectorButtons();

    // Load image for new page
    loadPageImage();
}

// Get current page's button array
function getCurrentButtons()
{
    if (!currentTemplate) return [];

    // New pages structure
    if (currentTemplate.pages && currentTemplate.pages[currentPageIndex])
    {
        return currentTemplate.pages[currentPageIndex].buttons || [];
    }

    // Legacy support: Handle old format with single buttons array
    if (currentTemplate.buttons && !currentTemplate.rightStick)
    {
        return currentPageIndex === 0 ? [] : currentTemplate.buttons;
    }

    // Legacy support: Get the appropriate stick
    const stick = currentPageIndex === 0 ? currentTemplate.leftStick : currentTemplate.rightStick;

    // Handle nested structure: { joystickNumber: 1, buttons: [...] }
    if (stick && typeof stick === 'object' && !Array.isArray(stick))
    {
        return stick.buttons || [];
    }

    // Handle flat array structure: [...]
    return stick || [];
}

function displayTemplate()
{
    if (!currentTemplate) return;

    // Helper to check if stick has buttons
    const hasButtons = (stick) =>
    {
        if (!stick) return false;
        if (Array.isArray(stick)) return stick.length > 0;
        if (stick.buttons && Array.isArray(stick.buttons)) return stick.buttons.length > 0;
        return false;
    };

    // Show/hide stick selector based on whether it's a dual stick template
    const isDualStick = (currentTemplate.leftStick || currentTemplate.rightStick) &&
        (hasButtons(currentTemplate.leftStick) || hasButtons(currentTemplate.rightStick));

    const selectorEl = document.getElementById('viewer-stick-selector');
    if (isDualStick)
    {
        selectorEl.style.display = 'flex';
    }
    else
    {
        selectorEl.style.display = 'none';
    }

    // Hide welcome screen and show canvas container with controls
    const welcomeScreen = document.getElementById('welcome-screen-visual');
    if (welcomeScreen) welcomeScreen.style.display = 'none';

    const canvasContainer = document.getElementById('viewer-canvas-container');
    if (canvasContainer) canvasContainer.style.display = 'flex';

    const viewerControls = document.getElementById('viewer-controls');
    if (viewerControls) viewerControls.style.display = 'flex';

    // Update hide defaults button
    updateHideDefaultsButton();

    // Show modifier toolbar
    const toolbar = document.getElementById('modifier-toolbar');
    if (toolbar)
    {
        toolbar.style.display = 'flex';
    }

    // Create page selector buttons
    createPageSelectorButtons();

    // Load the image for the current page
    loadPageImage();
}

function createPageSelectorButtons()
{
    const selectorEl = document.getElementById('viewer-stick-selector');
    if (!selectorEl) return;

    // Clear existing buttons
    selectorEl.innerHTML = '';

    // Determine number of pages
    let pages = [];
    if (currentTemplate.pages && currentTemplate.pages.length > 0)
    {
        // New multi-page structure
        pages = currentTemplate.pages;
    }
    else
    {
        // Legacy dual-stick structure
        const hasLeftStick = currentTemplate.leftStick &&
            (Array.isArray(currentTemplate.leftStick) ? currentTemplate.leftStick.length > 0 :
                currentTemplate.leftStick.buttons && currentTemplate.leftStick.buttons.length > 0);
        const hasRightStick = currentTemplate.rightStick &&
            (Array.isArray(currentTemplate.rightStick) ? currentTemplate.rightStick.length > 0 :
                currentTemplate.rightStick.buttons && currentTemplate.rightStick.buttons.length > 0);

        if (hasLeftStick)
        {
            pages.push({ name: 'Left Stick' });
        }
        if (hasRightStick)
        {
            pages.push({ name: 'Right Stick' });
        }
    }

    // Show selector only if multiple pages
    if (pages.length <= 1)
    {
        selectorEl.style.display = 'none';
        return;
    }

    selectorEl.style.display = 'flex';

    // Create button for each page
    pages.forEach((page, index) =>
    {
        const btn = document.createElement('button');
        btn.className = 'control-btn';
        if (index === currentPageIndex)
        {
            btn.classList.add('active');
        }
        btn.dataset.pageIndex = index;
        btn.title = `View ${page.name}`;

        const icon = document.createElement('span');
        icon.className = 'control-icon';
        icon.textContent = '🕹️';
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = page.name;
        btn.appendChild(text);

        selectorEl.appendChild(btn);
    });
}

function updatePageSelectorButtons()
{
    const selectorEl = document.getElementById('viewer-stick-selector');
    if (!selectorEl) return;

    const buttons = selectorEl.querySelectorAll('[data-page-index]');
    buttons.forEach((btn, index) =>
    {
        btn.classList.toggle('active', index === currentPageIndex);
    });
}

function loadPageImage()
{
    if (!currentTemplate) return;

    let imageDataUrl = null;
    let imageFlipped = false;

    // New pages structure
    if (currentTemplate.pages && currentTemplate.pages[currentPageIndex])
    {
        const currentPage = currentTemplate.pages[currentPageIndex];

        // Check if this page mirrors another page's image
        if (currentPage.mirror_from_page_id)
        {
            const sourcePage = currentTemplate.pages.find(p => p.id === currentPage.mirror_from_page_id);
            if (sourcePage && sourcePage.image_data_url)
            {
                imageDataUrl = sourcePage.image_data_url;
                imageFlipped = true; // Mirrored pages should be flipped
            }
        }
        else if (currentPage.image_data_url)
        {
            imageDataUrl = currentPage.image_data_url;
        }
    }
    else
    {
        // Legacy structure
        imageDataUrl = currentTemplate.imageDataUrl;
        imageFlipped = (currentTemplate.imageFlipped === currentPageIndex);
    }

    if (imageDataUrl)
    {
        // Load the image
        const img = new Image();
        img.onload = () =>
        {
            // Store image reference for resize handling
            window.viewerImage = img;
            window.viewerImageFlipped = imageFlipped;

            centerViewOnImage();

            // Resize canvas to container and draw
            resizeViewerCanvas();
        };

        img.src = imageDataUrl;
    }
    else
    {
        // No image for this page - render without background
        window.viewerImage = null;
        window.viewerImageFlipped = false;

        // Still resize canvas and draw buttons
        resizeViewerCanvas();
    }
}

function resizeViewerCanvas()
{
    const container = document.getElementById('viewer-canvas-container');
    if (!container) return;

    const rect = container.getBoundingClientRect();

    // Set CSS size for display
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    // Set internal resolution with device pixel ratio
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Reset bounds tracking for export
    resetDrawBounds();

    // Draw everything
    ctx.save();

    // Apply DPR scaling first
    ctx.scale(dpr, dpr);

    // Apply zoom and pan
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw the image with flip based on stored flip state (if image exists)
    if (window.viewerImage)
    {
        ctx.save();
        const shouldFlip = window.viewerImageFlipped || false;

        if (shouldFlip)
        {
            ctx.translate(window.viewerImage.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(window.viewerImage, 0, 0);
        ctx.restore();
    }

    // Draw all buttons with their bindings (without flip)
    // Don't track bounds for normal drawing - we need to populate clickable boxes
    drawButtons(window.viewerImage);

    // Draw highlight border around selected box if any
    if (selectedBox)
    {
        ctx.strokeStyle = '#7dd3c0';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        roundRect(ctx, selectedBox.x - 3, selectedBox.y - 3, selectedBox.width + 6, selectedBox.height + 6, 6);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    ctx.restore();
}

// Helper function to update bounds during drawing
function updateBounds(x, y, width = 0, height = 0)
{
    drawBounds.minX = Math.min(drawBounds.minX, x - width / 2);
    drawBounds.minY = Math.min(drawBounds.minY, y - height / 2);
    drawBounds.maxX = Math.max(drawBounds.maxX, x + width / 2);
    drawBounds.maxY = Math.max(drawBounds.maxY, y + height / 2);
}


// ========================================
// Button Drawing Functions
// ========================================

function drawButtons(img, mode = DrawMode.NORMAL)
{
    // Clear clickable boxes array (only in normal mode)
    if (mode === DrawMode.NORMAL)
    {
        clickableBoxes = [];
    }

    const buttons = getCurrentButtons();
    buttons.forEach(button =>
    {
        // Check if this is a 4-way hat
        if (button.buttonType === 'hat4way')
        {
            drawHat4Way(button, mode);
        }
        else
        {
            drawSingleButton(button, mode);
        }
    });
}

function drawSingleButton(button, mode = DrawMode.NORMAL)
{
    // Find ALL bindings for this button
    const bindings = findAllBindingsForButton(button);

    // Only track bounds in bounds mode
    if (mode === DrawMode.BOUNDS_ONLY)
    {
        if (bindings.length > 0)
        {
            updateBounds(button.buttonPos.x, button.buttonPos.y, 14, 14);
        }
        if (button.labelPos)
        {
            updateBounds(button.labelPos.x, button.labelPos.y, ButtonFrameWidth, ButtonFrameHeight);
        }
        return;
    }

    // Draw line connecting button to label
    if (button.labelPos)
    {
        const lineColor = bindings.length > 0 ? '#d9534f' : '#666';
        drawConnectingLine(ctx, button.buttonPos, button.labelPos, ButtonFrameWidth / 2, lineColor, false);
    }

    // Draw button position marker
    drawButtonMarker(ctx, button.buttonPos, 1, bindings.length > 0, false);

    // Draw label box with binding info
    if (button.labelPos)
    {
        drawBindingBoxLocal(button.labelPos.x, button.labelPos.y, simplifyButtonName(button.name), bindings, false, button, mode);
    }
}

function drawHat4Way(hat, mode = DrawMode.NORMAL)
{
    // Hat has 5 directions: up, down, left, right, push
    const directions = ['up', 'down', 'left', 'right', 'push'];

    // Check if push button exists
    const hasPush = hat.inputs && hat.inputs['push'];

    // Use centralized position calculation for consistency with template editor
    const positions = getHat4WayPositions(hat.labelPos.x, hat.labelPos.y, hasPush);

    // Only track bounds in bounds mode
    if (mode === DrawMode.BOUNDS_ONLY)
    {
        updateBounds(hat.buttonPos.x, hat.buttonPos.y, 12, 12);
        directions.forEach(dir =>
        {
            if (hat.inputs && hat.inputs[dir])
            {
                const pos = positions[dir];
                updateBounds(pos.x, pos.y, HatFrameWidth, HatFrameHeight);
            }
        });

        // Calculate title position using same logic as drawHat4WayBoxes
        const boxHalfHeight = HatFrameHeight / 2;
        const verticalDistanceWithPush = boxHalfHeight + HatSpacing + boxHalfHeight;
        const verticalDistanceNoPush = (HatFrameHeight + HatSpacing) / 2;
        const verticalDistance = hasPush ? verticalDistanceWithPush + (HatSpacing + HatSpacing / 2) : verticalDistanceNoPush + HatSpacing;
        const titleGap = 12;
        const titleY = hat.labelPos.y - verticalDistance - boxHalfHeight - titleGap;

        const textWidth = 60; // Approximate
        updateBounds(hat.labelPos.x, titleY, textWidth, 13);
        return;
    }

    // Draw center point marker
    drawButtonMarker(ctx, hat.buttonPos, 1, false, true);

    // Draw line to label area
    if (hat.labelPos)
    {
        const lineColor = '#666';
        drawConnectingLine(ctx, hat.buttonPos, hat.labelPos, HatFrameWidth / 2, lineColor, true); // true = isHat
    }

    // Callback to register clickable boxes
    const onClickableBox = (box) =>
    {
        if (mode === DrawMode.NORMAL)
        {
            clickableBoxes.push(box);
        }
    };

    // Store bindings by direction for passing to clickable boxes
    const bindingsByDirection = {};
    const directionsList = ['up', 'down', 'left', 'right', 'push'];
    directionsList.forEach(dir =>
    {
        if (hat.inputs && hat.inputs[dir])
        {
            bindingsByDirection[dir] = findAllBindingsForHatDirection(hat, dir);
        }
    });

    // Use unified rendering function with joystick viewer styling
    drawHat4WayBoxes(ctx, hat, {
        mode: mode,
        alpha: 1,
        getContentForDirection: (dir, input) =>
        {
            // Get bindings for this direction
            const bindings = bindingsByDirection[dir] || [];

            // Convert bindings to content lines array
            return bindings.map(binding =>
            {
                // Prepare action label with multi-tap indicator if present
                let actionLabel = binding.actionLabel || binding.action;
                if (binding.multiTap && binding.multiTap > 1)
                {
                    actionLabel += ` (${binding.multiTap}x)`;
                }

                // Apply styling based on binding type
                if (binding.isDefault)
                {
                    return `[muted]${actionLabel}`;
                }
                // Use [action] prefix for bound actions to apply green color
                return `[action]${actionLabel}`;
            });
        },
        colors: {
            titleColor: '#aaa',
            contentColor: '#ddd',
            subtleColor: '#999',
            mutedColor: '#888',
            actionColor: '#7dd3c0'
        },
        onClickableBox: onClickableBox,
        bindingsByDirection: bindingsByDirection,
        buttonDataForDirection: (dir) => ({ ...hat, direction: dir })
    });
}

// Local wrapper for shared drawBindingBox to handle clickable tracking and bounds
function drawBindingBoxLocal(x, y, label, bindings, compact = false, buttonData = null, mode = DrawMode.NORMAL)
{
    // Always update bounds in export mode
    if (mode === DrawMode.EXPORT)
    {
        const width = compact ? HatFrameWidth : ButtonFrameWidth;
        updateBounds(x, y, width, ButtonFrameHeight);
    }

    // Callback to register clickable boxes
    const onClickableBox = (box) =>
    {
        if (mode === DrawMode.NORMAL)
        {
            clickableBoxes.push(box);
        }
    };

    // Convert bindings to content lines array for improved rendering
    const contentLines = bindings.map(binding =>
    {
        // Prepare action label with multi-tap indicator if present
        let actionLabel = binding.actionLabel || binding.action;
        if (binding.multiTap && binding.multiTap > 1)
        {
            actionLabel += ` (${binding.multiTap}x)`;
        }

        // Apply styling based on binding type
        if (binding.isDefault)
        {
            return `[muted]${actionLabel}`;
        }
        // Use [action] prefix for bound actions to apply green color
        return `[action]${actionLabel}`;
    });

    // Use improved rendering function from button-renderer.js
    drawButtonBox(ctx, x, y, label, contentLines, compact, {
        hasBinding: bindings.length > 0,
        buttonData: buttonData,
        mode: mode,
        onClickableBox: onClickableBox,
        titleColor: '#ccc',
        contentColor: '#ddd',
        subtleColor: '#999',
        mutedColor: '#888',
        actionColor: '#7dd3c0',
        bindingsData: bindings
    });
}

// Helper functions now imported from button-renderer.js

// ========================================
// Binding Search Functions
// ========================================

// Helper to extract button ID or input string from button data
function extractButtonIdentifier(button, direction = null)
{
    const jsNum = getCurrentJoystickNumber();
    const jsPrefix = `js${jsNum}_`;

    let buttonNum = null;
    let inputString = null;

    // For hat direction, get the specific input for that direction
    if (direction && button.inputs && button.inputs[direction])
    {
        const dirInput = button.inputs[direction];

        if (typeof dirInput === 'string')
        {
            inputString = normalizeInputStringForStick(dirInput, jsPrefix);
        }
        else if (typeof dirInput === 'object' && dirInput.id !== undefined)
        {
            buttonNum = dirInput.id;
        }

        return { buttonNum, inputString, jsNum, jsPrefix };
    }

    // For regular buttons, use priority system:
    // 1. buttonId field (new simple format)
    // 2. inputs.main (legacy format with full SC string)
    // 3. Parse from button name (fallback)

    if (button.buttonId !== undefined && button.buttonId !== null)
    {
        buttonNum = button.buttonId;
    }
    else if (button.inputs && button.inputs.main)
    {
        const main = button.inputs.main;
        if (typeof main === 'object' && main.id !== undefined)
        {
            if (main.type === 'axis')
            {
                const directionSuffix = main.direction ? `_${main.direction}` : '';
                const axisString = `js${jsNum}_axis${main.id}${directionSuffix}`;
                inputString = normalizeInputStringForStick(axisString, jsPrefix);
            }
            else
            {
                buttonNum = main.id;
            }
        }
        else if (typeof main === 'string')
        {
            inputString = normalizeInputStringForStick(main, jsPrefix);
        }
    }
    else if (button.inputType === 'axis' && button.inputId !== undefined && button.inputId !== null)
    {
        // inputId might be a number (legacy: 1, 2, 3) or a string (new: "x", "y", "z")
        if (typeof button.inputId === 'string' && button.inputId.match(/^(x|y|z|rotx|roty|rotz|slider)$/i))
        {
            // Already a Star Citizen axis name
            inputString = normalizeInputStringForStick(`js${jsNum}_${button.inputId.toLowerCase()}`, jsPrefix);
        }
        else
        {
            // Legacy numeric format
            const directionSuffix = button.axisDirection ? `_${button.axisDirection}` : '';
            const axisString = `js${jsNum}_axis${button.inputId}${directionSuffix}`;
            inputString = normalizeInputStringForStick(axisString, jsPrefix);
        }
    }
    else if (button.inputType === 'button' && button.inputId !== undefined && button.inputId !== null)
    {
        buttonNum = button.inputId;
    }
    else
    {
        // Fallback: Try to parse button number from name
        // BUT: Only do this if the name actually contains "button"
        // This prevents "Axis 2" from incorrectly matching "Button 2"
        const buttonName = button.name.toLowerCase();

        // Only extract button number if "button" is in the name
        if (buttonName.includes('button'))
        {
            let match = buttonName.match(/button\((\d+)\)/);
            if (match)
            {
                buttonNum = parseInt(match[1]);
            }
            else
            {
                match = buttonName.match(/button\s+(\d+)/);
                if (match)
                {
                    buttonNum = parseInt(match[1]);
                }
                else
                {
                    const allNumbers = buttonName.match(/\d+/g);
                    if (allNumbers && allNumbers.length > 0)
                    {
                        buttonNum = parseInt(allNumbers[allNumbers.length - 1]);
                    }
                }
            }
        }
    }

    return { buttonNum, inputString, jsNum, jsPrefix };
}

// Unified function to search for all bindings matching a button identifier
function searchBindings(buttonIdentifier)
{
    if (!currentBindings) return [];

    const { buttonNum, inputString, jsNum, jsPrefix } = buttonIdentifier;
    const allBindings = [];

    // Search through all action maps for ALL bindings that use this button
    for (const actionMap of currentBindings.action_maps)
    {
        for (const action of actionMap.actions)
        {
            if (!action.bindings || action.bindings.length === 0) continue;

            for (const binding of action.bindings)
            {
                if (binding.input_type === 'Joystick')
                {
                    let input = binding.input.toLowerCase();
                    let modifiers = [];

                    // Extract modifier prefixes
                    if (input.includes('+'))
                    {
                        const parts = input.split('+');
                        modifiers = parts.slice(0, -1);
                        input = parts[parts.length - 1];
                    }

                    // Skip invalid/empty joystick bindings
                    if (!input || input.match(/^js\d+_\s*$/) || input.endsWith('_')) continue;

                    let isMatch = false;

                    // Exact match with input string
                    if (inputString && (input === inputString || input.startsWith(inputString + '_')))
                    {
                        isMatch = true;
                    }
                    // Match by button number - BUT ONLY FOR ACTUAL BUTTONS, NOT AXES
                    // This prevents "axis2" from incorrectly matching "button2"
                    else if (buttonNum !== null)
                    {
                        // Only use button number matching if the binding is actually a button
                        // Check that it doesn't contain 'axis' or 'hat' to avoid false matches
                        const buttonPattern = new RegExp(`^${jsPrefix}button${buttonNum}(?:_|$)`);
                        if (buttonPattern.test(input) && !input.includes('_axis') && !input.includes('_hat'))
                        {
                            isMatch = true;
                        }
                    }

                    if (isMatch)
                    {
                        let actionLabel = action.ui_label || action.display_name || action.name;

                        if (modifiers.length > 0)
                        {
                            actionLabel = modifiers.join('+') + ' + ' + actionLabel;
                        }

                        if (action.on_hold)
                        {
                            actionLabel += ' (Hold)';
                        }

                        const mapLabel = actionMap.ui_label || actionMap.display_name || actionMap.name;

                        allBindings.push({
                            action: actionLabel,
                            input: binding.display_name,
                            actionMap: mapLabel,
                            isDefault: binding.is_default,
                            modifiers: modifiers,
                            multiTap: binding.multi_tap,
                            activationMode: binding.activation_mode || null
                        });
                    }
                }
            }
        }
    }

    // Sort and filter
    allBindings.sort((a, b) =>
    {
        if (a.isDefault === b.isDefault) return 0;
        return a.isDefault ? 1 : -1;
    });

    let filteredBindings = allBindings;

    if (hideDefaultBindings)
    {
        filteredBindings = filteredBindings.filter(b => !b.isDefault);
    }

    if (modifierFilter !== 'all')
    {
        filteredBindings = filteredBindings.filter(b =>
            b.modifiers && b.modifiers.includes(modifierFilter)
        );
    }

    return filteredBindings;
}

function findAllBindingsForButton(button)
{
    return searchBindings(extractButtonIdentifier(button));
}

function findAllBindingsForHatDirection(hat, direction)
{
    return searchBindings(extractButtonIdentifier(hat, direction));
}

// ========================================
// Canvas Mouse & Keyboard Interaction
// ========================================

function getCanvasCoords(event)
{
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Convert screen coordinates to canvas coordinates
    const canvasX = (event.clientX - rect.left);
    const canvasY = (event.clientY - rect.top);

    // Reverse the DPR scaling
    const scaledX = canvasX / dpr;
    const scaledY = canvasY / dpr;

    // Reverse the pan and zoom transformations
    const imgX = (scaledX - pan.x) / zoom;
    const imgY = (scaledY - pan.y) / zoom;

    return { x: imgX, y: imgY };
}

function onCanvasMouseDown(event)
{
    // Middle click (button 1) or right click (button 2) for panning
    if (event.button === 1 || event.button === 2)
    {
        isPanning = true;
        lastPanPosition = { x: event.clientX, y: event.clientY };
        canvas.style.cursor = 'grabbing';
        event.preventDefault();
    }
}

function onCanvasContextMenu(event)
{
    // Prevent right-click context menu when over canvas
    if (isPanning || event.button === 2)
    {
        event.preventDefault();
    }
}

function onCanvasMouseUp(event)
{
    if (isPanning)
    {
        isPanning = false;
        canvas.style.cursor = 'default';

        // Save pan state to localStorage
        ViewerState.saveViewState();
    }
}

function onCanvasWheel(event)
{
    event.preventDefault();
    const delta = -event.deltaY / 1000;
    zoomBy(delta, event);
}

function zoomBy(delta, event = null)
{
    const oldZoom = zoom;
    zoom = Math.max(0.1, Math.min(5, zoom + delta));

    if (event)
    {
        // Zoom towards mouse position
        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        pan.x = mouseX - (mouseX - pan.x) * (zoom / oldZoom);
        pan.y = mouseY - (mouseY - pan.y) * (zoom / oldZoom);
    }

    // Save zoom and pan state to localStorage
    ViewerState.saveViewState();

    resizeViewerCanvas();
}

// Canvas click handler
function onCanvasClick(event)
{
    const coords = getCanvasCoords(event);
    const imgX = coords.x;
    const imgY = coords.y;

    // Check if click is within any clickable box (boxes are in image coordinates)
    for (const box of clickableBoxes)
    {
        if (imgX >= box.x && imgX <= box.x + box.width &&
            imgY >= box.y && imgY <= box.y + box.height)
        {
            selectedBox = box;
            showBindingInfo(box.buttonData, box.bindings);
            resizeViewerCanvas();
            return;
        }
    }

    // Click outside any box - hide info panel and deselect
    selectedBox = null;
    hideBindingInfo();
    resizeViewerCanvas();
} function onCanvasMouseMove(event)
{
    if (isPanning)
    {
        const deltaX = event.clientX - lastPanPosition.x;
        const deltaY = event.clientY - lastPanPosition.y;

        pan.x += deltaX;
        pan.y += deltaY;

        lastPanPosition = { x: event.clientX, y: event.clientY };
        resizeViewerCanvas();
        return;
    }

    const coords = getCanvasCoords(event);
    const imgX = coords.x;
    const imgY = coords.y;

    // Check if hovering over any clickable box (boxes are in image coordinates)
    let isOverBox = false;
    for (const box of clickableBoxes)
    {
        if (imgX >= box.x && imgX <= box.x + box.width &&
            imgY >= box.y && imgY <= box.y + box.height)
        {
            isOverBox = true;
            break;
        }
    }

    canvas.style.cursor = isOverBox ? 'pointer' : 'default';
}

function formatActivationModeLabel(mode)
{
    if (!mode)
    {
        return '';
    }

    const normalized = mode.replace(/^js\d+_/i, '').replace(/_/g, ' ');
    return normalized
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function showBindingInfo(buttonData, bindings)
{
    console.log('showBindingInfo called with:', buttonData.name, 'bindings:', bindings.length);
    selectedButton = { buttonData, bindings };

    // Create or update info panel
    let panel = document.getElementById('binding-info-panel');
    if (!panel)
    {
        console.log('Creating new binding-info-panel');
        panel = document.createElement('div');
        panel.id = 'binding-info-panel';
        panel.className = 'binding-info-panel';
        // Append to the joystick-display which is the actual viewing area
        const joystickDisplay = document.querySelector('.joystick-display');
        if (joystickDisplay)
        {
            joystickDisplay.appendChild(panel);
            console.log('Panel appended to joystick-display');
        }
        else
        {
            document.body.appendChild(panel);
            console.log('Panel appended to body (joystick-display not found)');
        }
    }

    // Build panel content
    let buttonName = simplifyButtonName(buttonData.name);
    if (buttonData.direction)
    {
        buttonName += ` - ${buttonData.direction.charAt(0).toUpperCase() + buttonData.direction.slice(1)}`;
    }

    const buttonIdString = getButtonIdString(buttonData);

    let html = `
        <div class="binding-info-header">
            <h3>${buttonName}</h3>
            <button class="binding-info-close" onclick="hideBindingInfo()">×</button>
        </div>
        <div class="binding-info-details">
            <span class="binding-info-id">Button ID: <code class="button-id-link" onclick="window.searchMainTabForButtonId('${buttonIdString}')" style="cursor: pointer; color: #4a9eff; text-decoration: underline;">${buttonIdString}</code></span>
        </div>
        <div class="binding-info-content">
    `;

    bindings.forEach(binding =>
    {
        // Prepare action label with multi-tap indicator if present
        let actionText = binding.action;
        if (binding.multiTap && binding.multiTap > 1)
        {
            actionText += ` <span class="multi-tap-badge">${binding.multiTap}x tap</span>`;
        }

        const activationModeHtml = binding.activationMode
            ? `<div class="binding-info-activation">Activation Mode: ${formatActivationModeLabel(binding.activationMode)}</div>`
            : '';

        html += `
            <div class="binding-info-item">
                <div class="binding-info-action">${actionText}</div>
                <div class="binding-info-category">${binding.actionMap}</div>
                ${activationModeHtml}
            </div>
        `;
    });

    html += `</div>`;
    panel.innerHTML = html;
    panel.style.display = 'block';
    console.log('Panel display set to block');
}

window.hideBindingInfo = function ()
{
    const panel = document.getElementById('binding-info-panel');
    if (panel)
    {
        panel.style.display = 'none';
    }
    selectedButton = null;
};

function getButtonIdString(buttonData)
{
    const identifier = extractButtonIdentifier(
        buttonData,
        buttonData.direction || null
    );

    if (identifier.inputString)
    {
        return identifier.inputString;
    }
    else if (identifier.buttonNum !== null)
    {
        return `js${identifier.jsNum}_button${identifier.buttonNum}`;
    }

    return 'Unknown';
}

// LocalStorage helpers for cleaner state management
const ViewerState = {
    save(key, value)
    {
        try
        {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error)
        {
            console.error('Error saving to localStorage:', error);
        }
    },

    load(key, defaultValue = null)
    {
        try
        {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : defaultValue;
        } catch (error)
        {
            console.error('Error loading from localStorage:', error);
            return defaultValue;
        }
    },

    saveTemplate(template, fileName)
    {
        this.save('currentTemplate', template);
        if (fileName)
        {
            localStorage.setItem('templateFileName', fileName);
        }
    },

    saveViewState()
    {
        this.save('viewerPan', pan);
        localStorage.setItem('viewerZoom', zoom.toString());
        localStorage.setItem('viewerCurrentPageIndex', currentPageIndex.toString());
        localStorage.setItem('hideDefaultBindings', hideDefaultBindings.toString());
        localStorage.setItem('modifierFilter', modifierFilter);
    }
};

// Global function to find a button name from an input string
window.findButtonNameForInput = function (inputString)
{
    if (!currentTemplate || !inputString) return null;

    inputString = inputString.toLowerCase().trim();

    // Helper to check match
    const checkMatch = (button, jsNum, direction = null) =>
    {
        const jsPrefix = `js${jsNum}_`;

        // Logic adapted from extractButtonIdentifier but using passed jsNum
        let buttonNum = null;
        let calculatedInputString = null;

        if (direction && button.inputs && button.inputs[direction])
        {
            const dirInput = button.inputs[direction];
            if (typeof dirInput === 'string')
            {
                calculatedInputString = normalizeInputStringForStick(dirInput, jsPrefix);
            }
            else if (typeof dirInput === 'object' && dirInput.id !== undefined)
            {
                buttonNum = dirInput.id;
            }
        }
        else
        {
            if (button.buttonId !== undefined && button.buttonId !== null)
            {
                buttonNum = button.buttonId;
            }
            else if (button.inputs && button.inputs.main)
            {
                const main = button.inputs.main;
                if (typeof main === 'object' && main.id !== undefined)
                {
                    if (main.type === 'axis')
                    {
                        const directionSuffix = main.direction ? `_${main.direction}` : '';
                        const axisString = `js${jsNum}_axis${main.id}${directionSuffix}`;
                        calculatedInputString = normalizeInputStringForStick(axisString, jsPrefix);
                    }
                    else
                    {
                        buttonNum = main.id;
                    }
                }
                else if (typeof main === 'string')
                {
                    calculatedInputString = normalizeInputStringForStick(main, jsPrefix);
                }
            }
            else if (button.inputType === 'axis' && button.inputId !== undefined && button.inputId !== null)
            {
                if (typeof button.inputId === 'string' && button.inputId.match(/^(x|y|z|rotx|roty|rotz|slider)$/i))
                {
                    calculatedInputString = normalizeInputStringForStick(`js${jsNum}_${button.inputId.toLowerCase()}`, jsPrefix);
                }
                else
                {
                    const directionSuffix = button.axisDirection ? `_${button.axisDirection}` : '';
                    const axisString = `js${jsNum}_axis${button.inputId}${directionSuffix}`;
                    calculatedInputString = normalizeInputStringForStick(axisString, jsPrefix);
                }
            }
            else if (button.inputType === 'button' && button.inputId !== undefined && button.inputId !== null)
            {
                buttonNum = button.inputId;
            }
        }

        if (calculatedInputString === inputString) return true;
        if (buttonNum !== null && inputString === `${jsPrefix}button${buttonNum}`) return true;

        return false;
    };

    // Iterate pages
    let pages = [];
    if (currentTemplate.pages && currentTemplate.pages.length > 0)
    {
        pages = currentTemplate.pages;
    }
    else
    {
        // Legacy support
        if (currentTemplate.leftStick) pages.push({ ...currentTemplate.leftStick, joystickNumber: 1 });
        if (currentTemplate.rightStick) pages.push({ ...currentTemplate.rightStick, joystickNumber: 2 });
    }

    for (const page of pages)
    {
        const jsNum = page.joystickNumber || 1;
        const buttons = page.buttons || [];

        for (const button of buttons)
        {
            if (button.buttonType === 'hat4way')
            {
                const directions = ['up', 'down', 'left', 'right', 'push'];
                for (const dir of directions)
                {
                    if (checkMatch(button, jsNum, dir))
                    {
                        return `${button.name} [${dir.charAt(0).toUpperCase() + dir.slice(1)}]`;
                    }
                }
            }
            else
            {
                if (checkMatch(button, jsNum))
                {
                    return button.name;
                }
            }
        }
    }

    return null;
};

// ========================================
// Drawing Bounds Tracking (for export)
// ========================================

function resetDrawBounds()
{
    drawBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

// ========================================
// Image Export
// ========================================

async function exportToImage()
{
    if (!window.viewerImage || !currentTemplate)
    {
        await window.showAlert('Please select a template first', 'Select Template');
        return;
    }

    try
    {
        // Show export in progress
        const btn = document.getElementById('export-image-btn');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<span class="control-icon">⏳</span><span>Exporting...</span>';
        btn.disabled = true;

        // First, calculate bounds by doing a dry-run draw to track bounds
        resetDrawBounds();
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');

        // Save old ctx and swap to temp for bounds tracking
        let savedCtx = ctx;
        ctx = tempCtx;
        drawButtons(window.viewerImage, DrawMode.BOUNDS_ONLY);
        ctx = savedCtx;

        // Create export canvas
        const padding = 20;
        const boundsWidth = drawBounds.maxX - drawBounds.minX;
        const boundsHeight = drawBounds.maxY - drawBounds.minY;

        if (!isFinite(boundsWidth) || !isFinite(boundsHeight) || boundsWidth <= 0 || boundsHeight <= 0)
        {
            await window.showAlert('No bindings to export. Please ensure bindings are visible.', 'Nothing to Export');
            btn.innerHTML = originalHTML;
            btn.disabled = false;
            return;
        }

        const exportCanvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        const exportWidth = Math.ceil((boundsWidth + padding * 2) * dpr);
        const exportHeight = Math.ceil((boundsHeight + padding * 2) * dpr);

        exportCanvas.width = exportWidth;
        exportCanvas.height = exportHeight;

        const exportCtx = exportCanvas.getContext('2d');

        // Dark background matching canvas theme
        exportCtx.fillStyle = '#0c0f11';
        exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

        exportCtx.scale(dpr, dpr);

        // Draw the joystick image centered and properly positioned
        const imgX = padding - drawBounds.minX;
        const imgY = padding - drawBounds.minY;

        const shouldFlip = window.viewerImageFlipped || false;
        if (shouldFlip)
        {
            exportCtx.save();
            exportCtx.translate(imgX + window.viewerImage.width, imgY);
            exportCtx.scale(-1, 1);
            exportCtx.drawImage(window.viewerImage, 0, 0);
            exportCtx.restore();
        }
        else
        {
            exportCtx.drawImage(window.viewerImage, imgX, imgY);
        }

        // Temporarily adjust context for drawing
        exportCtx.save();
        exportCtx.translate(imgX, imgY);

        // Draw all buttons and bindings
        savedCtx = ctx;
        ctx = exportCtx;
        drawButtons(window.viewerImage, DrawMode.EXPORT);
        ctx = savedCtx;

        exportCtx.restore();

        // Convert to PNG
        exportCanvas.toBlob(async (blob) =>
        {
            try
            {
                // Open save dialog
                const fileName = `joystick_bindings_${new Date().getTime()}.png`;

                let resourceDir;
                try
                {
                    resourceDir = await invoke('get_resource_dir');
                }
                catch (e)
                {
                    console.warn('Could not get resource directory:', e);
                }

                const filePath = await save({
                    defaultPath: resourceDir ? `${resourceDir}/${fileName}` : fileName,
                    filters: [
                        {
                            name: 'PNG Image',
                            extensions: ['png']
                        }
                    ]
                });

                if (!filePath)
                {
                    // User cancelled
                    btn.innerHTML = originalHTML;
                    btn.disabled = false;
                    return;
                }

                // Convert blob to array for Tauri
                const arrayBuffer = await blob.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);

                // Call Tauri command to save file
                await invoke('write_binary_file', {
                    path: filePath,
                    contents: Array.from(uint8Array)
                });

                btn.innerHTML = originalHTML;
                btn.disabled = false;

                // Show success message briefly
                btn.innerHTML = '<span class="control-icon">✓</span><span>Exported!</span>';
                setTimeout(() =>
                {
                    btn.innerHTML = originalHTML;
                }, 2000);
            } catch (error)
            {
                console.error('Error saving file:', error);
                await window.showAlert(`Failed to save image: ${error}`, 'Error');
                btn.innerHTML = originalHTML;
                btn.disabled = false;
            }
        });

    } catch (error)
    {
        console.error('Error exporting image:', error);
        await window.showAlert(`Export failed: ${error}`, 'Error');
        const btn = document.getElementById('export-image-btn');
        btn.innerHTML = '<span class="control-icon">💾</span><span>Export</span>';
        btn.disabled = false;
    }
}