const { invoke } = window.__TAURI__.core;
const { open, save } = window.__TAURI__.dialog;

// State
let currentTemplate = null;
let currentBindings = null;
let canvas, ctx;
let hasUnsavedChanges = false;
let selectedButton = null;
let clickableBoxes = []; // Track clickable binding boxes for mouse events
let canvasTransform = { x: 0, y: 0, scale: 1 }; // Current canvas transform
let zoom = 1.0;
let pan = { x: 0, y: 0 };
let isPanning = false;
let lastPanPosition = { x: 0, y: 0 };
let currentStick = 'right'; // Currently viewing 'left' or 'right'
let hideDefaultBindings = false; // Filter to hide default bindings
let modifierFilter = 'all'; // Current modifier filter: 'all', 'lalt', 'lctrl', etc.
let drawBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; // Track drawing bounds for export

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
    // Stick selector buttons
    const leftStickBtn = document.getElementById('viewer-left-stick-btn');
    const rightStickBtn = document.getElementById('viewer-right-stick-btn');
    if (leftStickBtn) leftStickBtn.addEventListener('click', () => switchStick('left'));
    if (rightStickBtn) rightStickBtn.addEventListener('click', () => switchStick('right'));

    // Hide defaults toggle button
    const hideDefaultsBtn = document.getElementById('hide-defaults-toggle');
    if (hideDefaultsBtn)
    {
        hideDefaultsBtn.addEventListener('click', () =>
        {
            hideDefaultBindings = !hideDefaultBindings;
            updateHideDefaultsButton();
            // Save preference
            localStorage.setItem('hideDefaultBindings', hideDefaultBindings.toString());
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
            localStorage.setItem('modifierFilter', modifierFilter);
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
        canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    }
}

async function loadCurrentBindings()
{
    try
    {
        // First try to get working copy from localStorage
        const workingBindings = localStorage.getItem('workingBindings');

        if (workingBindings)
        {
            console.log('Loading working copy of bindings from localStorage');
            currentBindings = JSON.parse(workingBindings);
            console.log('Loaded bindings with', currentBindings.action_maps?.length, 'action maps');
            return;
        }

        // Fallback: get merged bindings from backend (AllBinds + user customizations)
        console.log('No working copy found, loading from backend');
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
        const templateData = JSON.parse(text);

        // Handle old format: convert buttons array to rightStick
        if (templateData.buttons && !templateData.rightStick)
        {
            templateData.rightStick = { joystickNumber: 2, buttons: templateData.buttons };
            templateData.leftStick = { joystickNumber: 1, buttons: [] };
        }
        // Ensure nested structure has buttons array
        else if (templateData.leftStick || templateData.rightStick)
        {
            if (templateData.leftStick && typeof templateData.leftStick === 'object' && !Array.isArray(templateData.leftStick) && !templateData.leftStick.buttons)
            {
                templateData.leftStick.buttons = [];
            }
            if (templateData.rightStick && typeof templateData.rightStick === 'object' && !Array.isArray(templateData.rightStick) && !templateData.rightStick.buttons)
            {
                templateData.rightStick.buttons = [];
            }
        }

        // Handle old imageFlipped boolean format
        if (typeof templateData.imageFlipped === 'boolean')
        {
            templateData.imageFlipped = templateData.imageFlipped ? 'left' : 'right';
        }

        currentTemplate = templateData;

        // Persist to localStorage
        localStorage.setItem('currentTemplate', JSON.stringify(templateData));
        localStorage.setItem('templateFileName', file.name);

        // Update header template name
        console.log('onTemplateFileSelected - templateData.name:', templateData.name);
        console.log('window.updateTemplateIndicator exists:', typeof window.updateTemplateIndicator);
        if (window.updateTemplateIndicator)
        {
            console.log('Calling updateTemplateIndicator with:', templateData.name);
            window.updateTemplateIndicator(templateData.name);
        }
        else
        {
            console.log('window.updateTemplateIndicator is not available');
        }

        hasUnsavedChanges = false;
        displayTemplate();

    } catch (error)
    {
        console.error('Error loading template:', error);
        alert(`Failed to load template: ${error}`);
    }

    // Clear the input
    e.target.value = '';
}

function restoreViewState()
{
    try
    {
        // Restore current stick selection
        const savedStick = localStorage.getItem('viewerCurrentStick');
        if (savedStick && (savedStick === 'left' || savedStick === 'right'))
        {
            currentStick = savedStick;
            document.getElementById('viewer-left-stick-btn').classList.toggle('active', savedStick === 'left');
            document.getElementById('viewer-right-stick-btn').classList.toggle('active', savedStick === 'right');
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

        // Restore pan and zoom
        const savedPan = localStorage.getItem('viewerPan');
        const savedZoom = localStorage.getItem('viewerZoom');

        if (savedPan)
        {
            const panData = JSON.parse(savedPan);
            pan.x = panData.x || 0;
            pan.y = panData.y || 0;
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

function loadPersistedTemplate()
{
    try
    {
        const savedTemplate = localStorage.getItem('currentTemplate');
        if (savedTemplate)
        {
            currentTemplate = JSON.parse(savedTemplate);

            // Handle old format: convert buttons array to rightStick
            if (currentTemplate.buttons && !currentTemplate.rightStick)
            {
                currentTemplate.rightStick = { joystickNumber: 2, buttons: currentTemplate.buttons };
                currentTemplate.leftStick = { joystickNumber: 1, buttons: [] };
            }
            // Ensure nested structure has buttons array
            else if (currentTemplate.leftStick || currentTemplate.rightStick)
            {
                if (currentTemplate.leftStick && typeof currentTemplate.leftStick === 'object' && !Array.isArray(currentTemplate.leftStick) && !currentTemplate.leftStick.buttons)
                {
                    currentTemplate.leftStick.buttons = [];
                }
                if (currentTemplate.rightStick && typeof currentTemplate.rightStick === 'object' && !Array.isArray(currentTemplate.rightStick) && !currentTemplate.rightStick.buttons)
                {
                    currentTemplate.rightStick.buttons = [];
                }
            }

            // Handle old imageFlipped boolean format
            if (typeof currentTemplate.imageFlipped === 'boolean')
            {
                currentTemplate.imageFlipped = currentTemplate.imageFlipped ? 'left' : 'right';
            }

            // Update header template name
            if (window.updateTemplateIndicator)
            {
                window.updateTemplateIndicator(currentTemplate.name);
            }

            displayTemplate();
        }
    } catch (error)
    {
        console.error('Error loading persisted template:', error);
    }
}

// Stick switching
function switchStick(stick)
{
    if (currentStick === stick) return;

    currentStick = stick;

    // Save to localStorage
    localStorage.setItem('viewerCurrentStick', stick);

    // Update button states
    document.getElementById('viewer-left-stick-btn').classList.toggle('active', stick === 'left');
    document.getElementById('viewer-right-stick-btn').classList.toggle('active', stick === 'right');

    // Redraw with new stick
    if (window.viewerImage)
    {
        resizeViewerCanvas();
    }
}

// Get current stick's button array
function getCurrentButtons()
{
    if (!currentTemplate) return [];

    // Handle old format with single buttons array
    if (currentTemplate.buttons && !currentTemplate.rightStick)
    {
        return currentStick === 'left' ? [] : currentTemplate.buttons;
    }

    // Get the appropriate stick
    const stick = currentStick === 'left' ? currentTemplate.leftStick : currentTemplate.rightStick;

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

    // Load the image
    const img = new Image();
    img.onload = () =>
    {
        // Store image reference for resize handling
        window.viewerImage = img;

        // Resize canvas to container and draw
        resizeViewerCanvas();
    };

    img.src = currentTemplate.imageDataUrl;
}

function resizeViewerCanvas()
{
    if (!window.viewerImage) return;

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

    // Draw the image with flip based on current stick and imageFlipped setting
    // imageFlipped indicates which stick's image is the flipped version
    // So we flip when viewing that stick
    ctx.save();
    const shouldFlip = (currentStick === currentTemplate.imageFlipped);

    if (shouldFlip)
    {
        ctx.translate(window.viewerImage.width, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(window.viewerImage, 0, 0);
    ctx.restore();

    // Draw all buttons with their bindings (without flip)
    // Don't track bounds for normal drawing - we need to populate clickable boxes
    drawButtons(window.viewerImage);

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


function drawButtons(img, trackBounds = false)
{
    // Clear clickable boxes array (only when not tracking bounds)
    if (!trackBounds)
    {
        clickableBoxes = [];
    }

    const buttons = getCurrentButtons();
    buttons.forEach(button =>
    {
        // Check if this is a 4-way hat
        if (button.buttonType === 'hat4way')
        {
            drawHat4Way(button, trackBounds);
        }
        else
        {
            drawSingleButton(button, trackBounds);
        }
    });
}

function drawSingleButton(button, trackBounds = false)
{
    // Find ALL bindings for this button
    const bindings = findAllBindingsForButton(button);

    // Draw line connecting button to label
    if (button.labelPos)
    {
        const lineColor = bindings.length > 0 ? '#d9534f' : '#666';
        drawConnectingLine(button.buttonPos, button.labelPos, 140 / 2, lineColor);
    }

    // Draw button position marker
    ctx.fillStyle = bindings.length > 0 ? '#d9534f' : '#666';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(button.buttonPos.x, button.buttonPos.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Track bounds for button marker
    if (trackBounds)
    {
        updateBounds(button.buttonPos.x, button.buttonPos.y, 14, 14);
    }

    // Draw label box with binding info
    if (button.labelPos)
    {
        drawBindingBox(button.labelPos.x, button.labelPos.y, simplifyButtonName(button.name), bindings, false, button, trackBounds);
    }
}

function drawHat4Way(hat, trackBounds = false)
{
    // Hat has 5 directions: up, down, left, right, push
    const directions = ['up', 'down', 'left', 'right', 'push'];
    const spacing = 45; // Space between boxes in plus arrangement

    // Draw center point marker
    ctx.fillStyle = '#666';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hat.buttonPos.x, hat.buttonPos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Track bounds for center marker
    if (trackBounds)
    {
        updateBounds(hat.buttonPos.x, hat.buttonPos.y, 12, 12);
    }

    // Draw line to label area
    if (hat.labelPos)
    {
        const lineColor = '#666';
        drawConnectingLine(hat.buttonPos, hat.labelPos, 70 / 2, lineColor);
    }

    // Calculate positions for each direction in a plus pattern
    const positions = {
        'up': { x: hat.labelPos.x, y: hat.labelPos.y - spacing + 8 },
        'down': { x: hat.labelPos.x, y: hat.labelPos.y + spacing - 8 },
        'left': { x: hat.labelPos.x - spacing * 1.5, y: hat.labelPos.y },
        'right': { x: hat.labelPos.x + spacing * 1.5, y: hat.labelPos.y },
        'push': { x: hat.labelPos.x, y: hat.labelPos.y }
    };

    // Draw each direction's binding box
    directions.forEach(dir =>
    {
        if (hat.inputs && hat.inputs[dir])
        {
            const bindings = findAllBindingsForHatDirection(hat, dir);
            const pos = positions[dir];
            const label = dir === 'push' ? 'Push' : dir.charAt(0).toUpperCase();
            const buttonData = { ...hat, direction: dir }; // Include direction info

            drawBindingBox(pos.x, pos.y, label, bindings, true, buttonData, trackBounds); // true = compact mode
        }
    });

    // Draw hat name above the plus
    ctx.fillStyle = '#aaa';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(simplifyButtonName(hat.name), hat.labelPos.x, hat.labelPos.y - spacing * 2 + 20);

    // Track bounds for hat name text
    if (trackBounds)
    {
        const textWidth = ctx.measureText(simplifyButtonName(hat.name)).width;
        updateBounds(hat.labelPos.x, hat.labelPos.y - spacing * 2 + 20, textWidth, 13);
    }
}

function drawBindingBox(x, y, label, bindings, compact = false, buttonData = null, trackBounds = false)
{
    const width = compact ? 70 : 140;
    const height = compact ? 50 : 50; // Fixed height for consistent layout

    const boxX = x - width / 2;
    const boxY = y - height / 2;

    // Track bounds for this box
    if (trackBounds)
    {
        updateBounds(x, y, width, height);
    }

    // Box background with gradient
    const hasBinding = bindings && bindings.length > 0;
    ctx.fillStyle = hasBinding ? 'rgba(15, 18, 21, 0.95)' : 'rgba(30, 30, 30, 0.85)';
    ctx.strokeStyle = hasBinding ? '#c9c9c9ff' : '#555';
    ctx.lineWidth = hasBinding ? 1 : 1;

    // Rounded rectangle
    roundRect(ctx, boxX, boxY, width, height, 4);
    ctx.fill();
    ctx.stroke();

    // Track clickable area if there are bindings (only when not tracking bounds)
    if (hasBinding && buttonData && !trackBounds)
    {
        clickableBoxes.push({
            x: boxX,
            y: boxY,
            width: width,
            height: height,
            buttonData: buttonData,
            bindings: bindings
        });
    }

    // Button label
    ctx.fillStyle = '#ccc';
    ctx.font = compact ? '11px "Segoe UI", sans-serif' : '12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (hasBinding)
    {
        // Draw label at top
        ctx.fillText(label, x, y - (compact ? 10 : 14));

        // Find where custom bindings end and defaults begin
        let customEndIndex = 0;
        for (let i = 0; i < bindings.length; i++)
        {
            if (bindings[i].isDefault)
            {
                customEndIndex = i;
                break;
            }
        }

        // Draw binding info
        const maxWidth = width - 8;
        let yOffset = 0;

        // Show first binding
        let actionText = bindings[0].action;
        if (ctx.measureText(actionText).width > maxWidth)
        {
            while (ctx.measureText(actionText + '...').width > maxWidth && actionText.length > 0)
            {
                actionText = actionText.slice(0, -1);
            }
            actionText += '...';
        }

        // Color: cyan for custom, gray for default
        ctx.fillStyle = bindings[0].isDefault ? '#666' : '#4ec9b0';
        ctx.font = compact ? 'bold 9px "Segoe UI", sans-serif' : 'bold 10px "Segoe UI", sans-serif';
        ctx.fillText(actionText, x, y);
        yOffset = compact ? 10 : 12;

        // If there are more bindings, show second one and draw separator if transitioning to defaults
        if (bindings.length > 1)
        {
            let secondText = bindings[1].action;
            if (ctx.measureText(secondText).width > maxWidth)
            {
                while (ctx.measureText(secondText + '...').width > maxWidth && secondText.length > 0)
                {
                    secondText = secondText.slice(0, -1);
                }
                secondText += '...';
            }

            // If first is custom and second is default, draw a separator line
            // if (customEndIndex === 1 && bindings[0].isDefault === false && bindings[1].isDefault === true)
            // {
            //     ctx.strokeStyle = '#555';
            //     ctx.lineWidth = 1;
            //     ctx.setLineDash([2, 2]);
            //     ctx.beginPath();
            //     ctx.moveTo(boxX + 4, y + (compact ? 3 : 4));
            //     ctx.lineTo(boxX + width - 4, y + (compact ? 3 : 4));
            //     ctx.stroke();
            //     ctx.setLineDash([]);
            //     yOffset = compact ? 18 : 22;
            // }

            // Color: cyan for custom, gray for default
            ctx.fillStyle = bindings[1].isDefault ? '#666' : '#4ec9b0';
            ctx.font = compact ? 'bold 9px "Segoe UI", sans-serif' : 'bold 10px "Segoe UI", sans-serif';
            ctx.fillText(secondText, x, y + yOffset);

            // Show count if there are more than 2
            if (bindings.length > 2)
            {
                ctx.fillStyle = '#888';
                ctx.font = compact ? 'italic 8px "Segoe UI", sans-serif' : 'italic 9px "Segoe UI", sans-serif';
                ctx.fillText(`(+${bindings.length - 2} more)`, x, y + (compact ? 26 : 30));
            }
        }
    }
    else
    {
        // Unbound - just show label
        ctx.fillText(label, x, y - 6);
        ctx.fillStyle = '#666';
        ctx.font = compact ? 'italic 9px "Segoe UI", sans-serif' : 'italic 10px "Segoe UI", sans-serif';
        ctx.fillText('(unbound)', x, y + 8);
    }
}

// Helper function to draw connecting lines with smart positioning
function drawConnectingLine(buttonPos, boxPos, boxHalfWidth, lineColor)
{
    // Determine if box is to the left or right of button
    const isBoxToRight = boxPos.x > buttonPos.x;

    // Calculate connection point on the box edge
    let connectionX, connectionY;
    if (isBoxToRight)
    {
        // Box is to the right, connect to left edge
        connectionX = boxPos.x - boxHalfWidth;
    }
    else
    {
        // Box is to the left, connect to right edge
        connectionX = boxPos.x + boxHalfWidth;
    }
    connectionY = boxPos.y;

    // Draw dashed line from button to box edge
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(buttonPos.x, buttonPos.y);
    ctx.lineTo(connectionX, connectionY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw circle at connection point
    ctx.fillStyle = '#aaaaaaff';
    ctx.strokeStyle = '#aaaaaaff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(connectionX, connectionY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

// Helper function to draw rounded rectangles
function roundRect(ctx, x, y, width, height, radius)
{
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

// Simplify button names for display
function simplifyButtonName(name)
{
    // Remove "Joystick 1 - " or "Button Button" prefixes
    name = name.replace(/^Joystick \d+ - /, '');
    name = name.replace(/^Button /, '');

    // Simplify common patterns
    name = name.replace(/Button\((\d+)\)/, 'Btn $1');
    name = name.replace(/^(\d+)$/, 'Btn $1');

    return name;
}

function findAllBindingsForButton(button)
{
    if (!currentBindings) return [];

    const allBindings = [];

    // Get joystick number from current stick object
    const currentStickData = currentStick === 'left' ? currentTemplate.leftStick : currentTemplate.rightStick;
    const jsNum = (currentStickData && currentStickData.joystickNumber) || currentTemplate.joystickNumber || 1;
    const jsPrefix = `js${jsNum}_`;

    // Determine button ID using priority system:
    // 1. buttonId field (new simple format)
    // 2. inputs.main (legacy format with full SC string)
    // 3. Parse from button name (fallback)

    let buttonNum = null;
    let buttonInputString = null;

    // First priority: Check for buttonId field (new simple format)
    if (button.buttonId !== undefined && button.buttonId !== null)
    {
        buttonNum = button.buttonId;
    }
    // Second priority: Check for inputs.main (legacy or new format)
    else if (button.inputs && button.inputs.main)
    {
        const main = button.inputs.main;
        // Handle both new format (object with id) and legacy format (string)
        if (typeof main === 'object' && main.id !== undefined)
        {
            buttonNum = main.id;
        }
        else if (typeof main === 'string')
        {
            // Store the input string but replace its joystick number with the current stick's number
            buttonInputString = main.toLowerCase().replace(/^js[12]_/, jsPrefix);
        }
    }
    // Third priority: Parse button number from name (last resort fallback)
    else
    {
        const buttonName = button.name.toLowerCase();

        // Try to extract button number from name with multiple patterns
        // 1. "Button(X)" or "button(X)" - from auto-detected names
        // 2. "Button X" or "button X" - from manual names
        // 3. Last number in the string - as final fallback

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
                // Extract the last number in the string as fallback
                const allNumbers = buttonName.match(/\d+/g);
                if (allNumbers && allNumbers.length > 0)
                {
                    buttonNum = parseInt(allNumbers[allNumbers.length - 1]);
                }
            }
        }
    }

    // Search through all action maps for ALL bindings that use this button
    for (const actionMap of currentBindings.action_maps)
    {
        for (const action of actionMap.actions)
        {
            // Skip if action has no bindings
            if (!action.bindings || action.bindings.length === 0) continue;

            for (const binding of action.bindings)
            {
                if (binding.input_type === 'Joystick')
                {
                    let input = binding.input.toLowerCase();
                    let modifiers = [];

                    // Extract modifier prefixes (e.g., "lalt+rctrl+js1_button3" -> ["lalt", "rctrl"])
                    if (input.includes('+'))
                    {
                        const parts = input.split('+');
                        modifiers = parts.slice(0, -1); // All parts except the last are modifiers
                        input = parts[parts.length - 1]; // Get the last part after all modifiers
                    }

                    // Skip invalid/empty joystick bindings (like "js1_" with nothing after)
                    if (!input || input.match(/^js\d+_\s*$/) || input.endsWith('_')) continue;

                    let isMatch = false;

                    // First priority: exact match with the stored input string
                    if (buttonInputString && input === buttonInputString)
                    {
                        isMatch = true;
                    }
                    // Second priority: match by button number with correct joystick
                    else if (buttonNum !== null)
                    {
                        // Match exact button number - must be followed by underscore or end of string
                        // This prevents js1_button1 from matching js1_button10/js1_button11
                        const buttonPattern = new RegExp(`^${jsPrefix}button${buttonNum}(?:_|$)`);
                        if (buttonPattern.test(input))
                        {
                            isMatch = true;
                        }
                    }
                    // Third priority: match hat switches
                    else if (buttonInputString)
                    {
                        const buttonPart = buttonInputString.replace(/^js[12]_/, '');
                        const inputPart = input.replace(/^js[12]_/, '');
                        if (buttonPart === inputPart && input.startsWith(jsPrefix))
                        {
                            isMatch = true;
                        }
                    }

                    if (isMatch)
                    {
                        // Use ui_label if available, otherwise display_name as fallback
                        let actionLabel = action.ui_label || action.display_name || action.name;

                        // Add modifier prefix to action label if present
                        if (modifiers.length > 0)
                        {
                            actionLabel = modifiers.join('+') + ' + ' + actionLabel;
                        }

                        // Add (Hold) suffix if this action requires holding
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
                            modifiers: modifiers
                        });
                    }
                }
            }
        }
    }

    // Sort: custom bindings first (is_default: false), then defaults (is_default: true)
    allBindings.sort((a, b) =>
    {
        if (a.isDefault === b.isDefault) return 0;
        return a.isDefault ? 1 : -1;  // Custom (false) comes before default (true)
    });

    // Filter bindings based on current filters
    let filteredBindings = allBindings;

    // Filter out default bindings if hideDefaultBindings is enabled
    if (hideDefaultBindings)
    {
        filteredBindings = filteredBindings.filter(b => !b.isDefault);
    }

    // Filter by modifier if not "all"
    if (modifierFilter !== 'all')
    {
        filteredBindings = filteredBindings.filter(b =>
            b.modifiers && b.modifiers.includes(modifierFilter)
        );
    }

    return filteredBindings;
}

function findAllBindingsForHatDirection(hat, direction)
{
    if (!currentBindings || !hat.inputs || !hat.inputs[direction]) return [];

    const allBindings = [];

    // Get joystick number from current stick object
    const currentStickData = currentStick === 'left' ? currentTemplate.leftStick : currentTemplate.rightStick;
    const jsNum = (currentStickData && currentStickData.joystickNumber) || currentTemplate.joystickNumber || 1;
    const dirInput = hat.inputs[direction];

    // Handle both formats:
    // 1. String format: "js1_hat1_left"
    // 2. Object format: { type: "button", id: 14 }
    let patterns = [];
    let inputString = null;

    if (typeof dirInput === 'string')
    {
        // String format - replace joystick number with current stick's number
        inputString = dirInput.toLowerCase().replace(/^js[12]_/, `js${jsNum}_`);
        patterns.push(inputString);
    }
    else if (typeof dirInput === 'object' && dirInput.id !== undefined)
    {
        // Object format with button ID
        const buttonId = dirInput.id;
        patterns.push(`js${jsNum}_button${buttonId}`);
    }

    if (patterns.length === 0) return [];

    // Search through all action maps
    for (const actionMap of currentBindings.action_maps)
    {
        for (const action of actionMap.actions)
        {
            // Skip if action has no bindings
            if (!action.bindings || action.bindings.length === 0) continue;

            for (const binding of action.bindings)
            {
                if (binding.input_type === 'Joystick')
                {
                    let input = binding.input.toLowerCase();
                    let modifiers = [];

                    // Extract modifier prefixes (e.g., "lalt+rctrl+js1_button3" -> ["lalt", "rctrl"])
                    if (input.includes('+'))
                    {
                        const parts = input.split('+');
                        modifiers = parts.slice(0, -1); // All parts except the last are modifiers
                        input = parts[parts.length - 1]; // Get the last part after all modifiers
                    }

                    // Skip invalid/empty joystick bindings (like "js1_" with nothing after)
                    if (!input || input.match(/^js\d+_\s*$/) || input.endsWith('_')) continue;

                    for (const pattern of patterns)
                    {
                        if (input === pattern || input.startsWith(pattern + '_'))
                        {
                            // Use ui_label if available, otherwise display_name as fallback
                            let actionLabel = action.ui_label || action.display_name || action.name;

                            // Add modifier prefix to action label if present
                            if (modifiers.length > 0)
                            {
                                actionLabel = modifiers.join('+') + ' + ' + actionLabel;
                            }

                            // Add (Hold) suffix if this action requires holding
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
                                modifiers: modifiers
                            });
                            break;
                        }
                    }
                }
            }
        }
    }

    // Sort: custom bindings first (is_default: false), then defaults (is_default: true)
    allBindings.sort((a, b) =>
    {
        if (a.isDefault === b.isDefault) return 0;
        return a.isDefault ? 1 : -1;  // Custom (false) comes before default (true)
    });

    // Filter bindings based on current filters
    let filteredBindings = allBindings;

    // Filter out default bindings if hideDefaultBindings is enabled
    if (hideDefaultBindings)
    {
        filteredBindings = filteredBindings.filter(b => !b.isDefault);
    }

    // Filter by modifier if not "all"
    if (modifierFilter !== 'all')
    {
        filteredBindings = filteredBindings.filter(b =>
            b.modifiers && b.modifiers.includes(modifierFilter)
        );
    }

    return filteredBindings;
}

// Canvas mouse handlers
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
    // Middle click for panning
    if (event.button === 1)
    {
        isPanning = true;
        lastPanPosition = { x: event.clientX, y: event.clientY };
        canvas.style.cursor = 'grabbing';
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
        localStorage.setItem('viewerPan', JSON.stringify({ x: pan.x, y: pan.y }));
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
    localStorage.setItem('viewerZoom', zoom.toString());
    localStorage.setItem('viewerPan', JSON.stringify({ x: pan.x, y: pan.y }));

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
            showBindingInfo(box.buttonData, box.bindings);
            return;
        }
    }

    // Click outside any box - hide info panel
    hideBindingInfo();
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
} function showBindingInfo(buttonData, bindings)
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
            <span class="binding-info-id">Button ID: <code>${buttonIdString}</code></span>
        </div>
        <div class="binding-info-content">
    `;

    bindings.forEach(binding =>
    {
        html += `
            <div class="binding-info-item">
                <div class="binding-info-action">${binding.action}</div>
                <div class="binding-info-category">${binding.actionMap}</div>
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
    // Get joystick number from current stick object
    const currentStickData = currentStick === 'left' ? currentTemplate.leftStick : currentTemplate.rightStick;
    const jsNum = (currentStickData && currentStickData.joystickNumber) || currentTemplate.joystickNumber || 1;

    // For hat with direction
    if (buttonData.direction && buttonData.inputs && buttonData.inputs[buttonData.direction])
    {
        const dirInput = buttonData.inputs[buttonData.direction];

        // Handle object format: { type: "button", id: 14 }
        if (typeof dirInput === 'object' && dirInput.id !== undefined)
        {
            return `js${jsNum}_button${dirInput.id}`;
        }
        // Handle string format: "js1_hat1_left"
        else if (typeof dirInput === 'string')
        {
            return dirInput.replace(/^js\d+_/, `js${jsNum}_`);
        }
    }

    // For regular button
    // Priority 1: buttonId field
    if (buttonData.buttonId !== undefined && buttonData.buttonId !== null)
    {
        return `js${jsNum}_button${buttonData.buttonId}`;
    }

    // Priority 2: inputs.main
    if (buttonData.inputs && buttonData.inputs.main)
    {
        const main = buttonData.inputs.main;
        if (typeof main === 'object' && main.id !== undefined)
        {
            return `js${jsNum}_button${main.id}`;
        }
        else if (typeof main === 'string')
        {
            return main.replace(/^js\d+_/, `js${jsNum}_`);
        }
    }

    // Priority 3: Parse from name
    const buttonName = buttonData.name.toLowerCase();
    let match = buttonName.match(/button\((\d+)\)/);
    if (match)
    {
        return `js${jsNum}_button${match[1]}`;
    }

    match = buttonName.match(/button\s+(\d+)/);
    if (match)
    {
        return `js${jsNum}_button${match[1]}`;
    }

    // Fallback: extract last number
    const allNumbers = buttonName.match(/\d+/g);
    if (allNumbers && allNumbers.length > 0)
    {
        return `js${jsNum}_button${allNumbers[allNumbers.length - 1]}`;
    }

    return 'Unknown';
}

function updateFileIndicator()
{
    const indicator = document.getElementById('loaded-file-indicator');
    const fileNameEl = document.getElementById('loaded-file-name');
    const savedPath = localStorage.getItem('keybindingsFilePath');

    if (indicator && fileNameEl && savedPath)
    {
        // Extract just the filename from the path
        const fileName = savedPath.split(/[\\\\/]/).pop();
        fileNameEl.textContent = fileName;
        indicator.style.display = 'flex';
    }
}

function resetDrawBounds()
{
    drawBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function updateDrawBounds(x, y, width = 0, height = 0)
{
    const left = x - width / 2;
    const right = x + width / 2;
    const top = y - height / 2;
    const bottom = y + height / 2;

    drawBounds.minX = Math.min(drawBounds.minX, left);
    drawBounds.minY = Math.min(drawBounds.minY, top);
    drawBounds.maxX = Math.max(drawBounds.maxX, right);
    drawBounds.maxY = Math.max(drawBounds.maxY, bottom);
}

async function exportToImage()
{
    if (!window.viewerImage || !currentTemplate)
    {
        alert('Please select a template first');
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

        // Run drawButtonsForExport with bounds tracking
        drawButtonsForExportWithBounds(tempCtx, window.viewerImage);

        // Create export canvas
        const padding = 20;
        const boundsWidth = drawBounds.maxX - drawBounds.minX;
        const boundsHeight = drawBounds.maxY - drawBounds.minY;

        if (!isFinite(boundsWidth) || !isFinite(boundsHeight) || boundsWidth <= 0 || boundsHeight <= 0)
        {
            alert('No bindings to export. Please ensure bindings are visible.');
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

        const shouldFlip = (currentStick === currentTemplate.imageFlipped);
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
        drawButtonsForExport(exportCtx, window.viewerImage);

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
                alert(`Failed to save image: ${error}`);
                btn.innerHTML = originalHTML;
                btn.disabled = false;
            }
        });

    } catch (error)
    {
        console.error('Error exporting image:', error);
        alert(`Export failed: ${error}`);
        const btn = document.getElementById('export-image-btn');
        btn.innerHTML = '<span class="control-icon">💾</span><span>Export</span>';
        btn.disabled = false;
    }
}

function drawButtonsForExport(exportCtx, img)
{
    const buttons = getCurrentButtons();
    buttons.forEach(button =>
    {
        if (button.buttonType === 'hat4way')
        {
            drawHat4WayExport(exportCtx, button);
        }
        else
        {
            drawSingleButtonExport(exportCtx, button);
        }
    });
}

function drawButtonsForExportWithBounds(exportCtx, img)
{
    const buttons = getCurrentButtons();
    buttons.forEach(button =>
    {
        if (button.buttonType === 'hat4way')
        {
            drawHat4WayExportWithBounds(exportCtx, button);
        }
        else
        {
            drawSingleButtonExportWithBounds(exportCtx, button);
        }
    });
}

function drawSingleButtonExport(ctx, button)
{
    // Find ALL bindings for this button
    const bindings = findAllBindingsForButton(button);

    // Draw line connecting button to label
    if (button.labelPos)
    {
        const lineColor = bindings.length > 0 ? '#d9534f' : '#666';
        drawConnectingLineExport(ctx, button.buttonPos, button.labelPos, 140 / 2, lineColor);
    }

    // Draw button position marker
    ctx.fillStyle = bindings.length > 0 ? '#d9534f' : '#666';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(button.buttonPos.x, button.buttonPos.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw label box with binding info
    if (button.labelPos)
    {
        drawBindingBoxExport(ctx, button.labelPos.x, button.labelPos.y, simplifyButtonName(button.name), bindings, false, button);
    }
}

function drawHat4WayExport(ctx, hat)
{
    // Hat has 5 directions: up, down, left, right, push
    const directions = ['up', 'down', 'left', 'right', 'push'];
    const spacing = 45; // Space between boxes in plus arrangement

    // Draw center point marker
    ctx.fillStyle = '#666';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hat.buttonPos.x, hat.buttonPos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw line to label area
    if (hat.labelPos)
    {
        const lineColor = '#666';
        drawConnectingLineExport(ctx, hat.buttonPos, hat.labelPos, 70 / 2, lineColor);
    }

    // Calculate positions for each direction in a plus pattern
    const positions = {
        'up': { x: hat.labelPos.x, y: hat.labelPos.y - spacing + 8 },
        'down': { x: hat.labelPos.x, y: hat.labelPos.y + spacing - 8 },
        'left': { x: hat.labelPos.x - spacing * 1.5, y: hat.labelPos.y },
        'right': { x: hat.labelPos.x + spacing * 1.5, y: hat.labelPos.y },
        'push': { x: hat.labelPos.x, y: hat.labelPos.y }
    };

    // Draw each direction's binding box
    directions.forEach(dir =>
    {
        if (hat.inputs && hat.inputs[dir])
        {
            const bindings = findAllBindingsForHatDirection(hat, dir);
            const pos = positions[dir];
            const label = dir === 'push' ? 'Push' : dir.charAt(0).toUpperCase();
            const buttonData = { ...hat, direction: dir }; // Include direction info

            drawBindingBoxExport(ctx, pos.x, pos.y, label, bindings, true, buttonData); // true = compact mode
        }
    });

    // Draw hat name above the plus
    ctx.fillStyle = '#aaa';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(simplifyButtonName(hat.name), hat.labelPos.x, hat.labelPos.y - spacing * 2 + 20);
}

function drawConnectingLineExport(ctx, buttonPos, boxPos, boxHalfWidth, lineColor)
{
    // Determine if box is to the left or right of button
    const isBoxToRight = boxPos.x > buttonPos.x;

    // Calculate connection point on the box edge
    let connectionX, connectionY;
    if (isBoxToRight)
    {
        // Box is to the right, connect to left edge
        connectionX = boxPos.x - boxHalfWidth;
    }
    else
    {
        // Box is to the left, connect to right edge
        connectionX = boxPos.x + boxHalfWidth;
    }
    connectionY = boxPos.y;

    // Draw dashed line from button to box edge
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(buttonPos.x, buttonPos.y);
    ctx.lineTo(connectionX, connectionY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw circle at connection point
    ctx.fillStyle = '#aaaaaaff';
    ctx.strokeStyle = '#aaaaaaff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(connectionX, connectionY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

function drawBindingBoxExport(ctx, x, y, label, bindings, compact = false, buttonData = null)
{
    const width = compact ? 70 : 140;
    const height = compact ? 50 : 50; // Fixed height for consistent layout

    const boxX = x - width / 2;
    const boxY = y - height / 2;

    // Update draw bounds
    updateDrawBounds(x, y, width, height);

    // Box background with gradient
    const hasBinding = bindings && bindings.length > 0;
    ctx.fillStyle = hasBinding ? 'rgba(15, 18, 21, 0.95)' : 'rgba(30, 30, 30, 0.85)';
    ctx.strokeStyle = hasBinding ? '#c9c9c9ff' : '#555';
    ctx.lineWidth = hasBinding ? 1 : 1;

    // Rounded rectangle
    roundRect(ctx, boxX, boxY, width, height, 4);
    ctx.fill();
    ctx.stroke();

    // Button label
    ctx.fillStyle = '#ccc';
    ctx.font = compact ? '11px "Segoe UI", sans-serif' : '12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (hasBinding)
    {
        // Draw label at top
        ctx.fillText(label, x, y - (compact ? 10 : 14));

        // Find where custom bindings end and defaults begin
        let customEndIndex = 0;
        for (let i = 0; i < bindings.length; i++)
        {
            if (bindings[i].isDefault)
            {
                customEndIndex = i;
                break;
            }
        }

        // Draw binding info
        const maxWidth = width - 8;
        let yOffset = 0;

        // Show first binding
        let actionText = bindings[0].action;
        if (ctx.measureText(actionText).width > maxWidth)
        {
            while (ctx.measureText(actionText + '...').width > maxWidth && actionText.length > 0)
            {
                actionText = actionText.slice(0, -1);
            }
            actionText += '...';
        }

        // Color: cyan for custom, gray for default
        ctx.fillStyle = bindings[0].isDefault ? '#666' : '#4ec9b0';
        ctx.font = compact ? 'bold 9px "Segoe UI", sans-serif' : 'bold 10px "Segoe UI", sans-serif';
        ctx.fillText(actionText, x, y);
        yOffset = compact ? 10 : 12;

        // If there are more bindings, show second one and draw separator if transitioning to defaults
        if (bindings.length > 1)
        {
            let secondText = bindings[1].action;
            if (ctx.measureText(secondText).width > maxWidth)
            {
                while (ctx.measureText(secondText + '...').width > maxWidth && secondText.length > 0)
                {
                    secondText = secondText.slice(0, -1);
                }
                secondText += '...';
            }

            // Color: cyan for custom, gray for default
            ctx.fillStyle = bindings[1].isDefault ? '#666' : '#4ec9b0';
            ctx.font = compact ? 'bold 9px "Segoe UI", sans-serif' : 'bold 10px "Segoe UI", sans-serif';
            ctx.fillText(secondText, x, y + yOffset);

            // Show count if there are more than 2
            if (bindings.length > 2)
            {
                ctx.fillStyle = '#888';
                ctx.font = compact ? 'italic 8px "Segoe UI", sans-serif' : 'italic 9px "Segoe UI", sans-serif';
                ctx.fillText(`(+${bindings.length - 2} more)`, x, y + (compact ? 26 : 30));
            }
        }
    }
    else
    {
        // Unbound - just show label
        ctx.fillText(label, x, y - 6);
        ctx.fillStyle = '#666';
        ctx.font = compact ? 'italic 9px "Segoe UI", sans-serif' : 'italic 10px "Segoe UI", sans-serif';
        ctx.fillText('(unbound)', x, y + 8);
    }
}

function drawSingleButtonExportWithBounds(ctx, button)
{
    // Find ALL bindings for this button
    const bindings = findAllBindingsForButton(button);

    // Update bounds for button marker
    if (bindings.length > 0)
    {
        updateDrawBounds(button.buttonPos.x, button.buttonPos.y, 14, 14);
    }

    // Update bounds for label box with binding info
    if (button.labelPos)
    {
        updateDrawBounds(button.labelPos.x, button.labelPos.y, 140, 50);
    }
}

function drawHat4WayExportWithBounds(ctx, hat)
{
    // Hat has 5 directions: up, down, left, right, push
    const directions = ['up', 'down', 'left', 'right', 'push'];
    const spacing = 45; // Space between boxes in plus arrangement

    // Update bounds for center marker
    updateDrawBounds(hat.buttonPos.x, hat.buttonPos.y, 12, 12);

    // Calculate positions for each direction in a plus pattern
    const positions = {
        'up': { x: hat.labelPos.x, y: hat.labelPos.y - spacing + 8 },
        'down': { x: hat.labelPos.x, y: hat.labelPos.y + spacing - 8 },
        'left': { x: hat.labelPos.x - spacing * 1.5, y: hat.labelPos.y },
        'right': { x: hat.labelPos.x + spacing * 1.5, y: hat.labelPos.y },
        'push': { x: hat.labelPos.x, y: hat.labelPos.y }
    };

    // Update bounds for each direction's binding box
    directions.forEach(dir =>
    {
        if (hat.inputs && hat.inputs[dir])
        {
            const pos = positions[dir];
            updateDrawBounds(pos.x, pos.y, 70, 50); // compact mode uses 70x50
        }
    });

    // Update bounds for hat name text
    const textWidth = 60; // Approximate
    updateDrawBounds(hat.labelPos.x, hat.labelPos.y - spacing * 2 + 20, textWidth, 13);
}


