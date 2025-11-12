// Safely access TAURI APIs
let invoke, open, save;

if (window.__TAURI__)
{
    invoke = window.__TAURI__.core.invoke;
    ({ open, save } = window.__TAURI__.dialog);
}

// Lazy imports - will be loaded when needed
let parseInputDisplayName, parseInputShortName, getInputType;

// Load utilities when template editor initializes
async function loadUtilities()
{
    if (!parseInputDisplayName)
    {
        const utils = await import('./input-utils.js');
        parseInputDisplayName = utils.parseInputDisplayName;
        parseInputShortName = utils.parseInputShortName;
        getInputType = utils.getInputType;
    }
}

// State
let templateData = {
    name: '',
    joystickModel: '',
    joystickNumber: 2, // Default to joystick 2 (for dual stick setups) - deprecated, use per-stick joystickNumber
    imagePath: '',
    imageDataUrl: null,
    imageFlipped: 'right', // 'left', 'right', or 'none' - indicates which stick needs to be flipped, or 'none' if no mirroring
    imageType: 'single', // 'single' (one image for both sticks) or 'dual' (separate left/right images)
    leftImagePath: '', // For dual image mode
    leftImageDataUrl: null, // For dual image mode
    rightImagePath: '', // For dual image mode
    rightImageDataUrl: null, // For dual image mode
    leftStick: { joystickNumber: 1, buttons: [] }, // Left stick config
    rightStick: { joystickNumber: 2, buttons: [] } // Right stick config
};

let currentStick = 'right'; // Currently editing 'left' or 'right'
let canvas, ctx;
let loadedImage = null;
let zoom = 1.0;
let pan = { x: 0, y: 0 };
let selectedButtonId = null;
let mode = 'view'; // 'view', 'placing-button', 'placing-label'
let tempButton = null;
let originalButton = null; // Store original button data for cancel functionality
let draggingHandle = null;
let isPanning = false;
let lastPanPosition = { x: 0, y: 0 };

// Snapping grid for better alignment when dragging boxes
const SNAP_GRID = 10; // pixels

// Joystick input detection
let detectingInput = false;
let inputDetectionTimeout = null; // Track timeout to clear it when restarting
let hatDetectionTimeout = null; // Track hat detection timeout to clear it when restarting
let currentDetectionSessionId = null; // Track current detection session to prevent race conditions
let currentHatDetectionSessionId = null; // Track current hat detection session

// Track unsaved changes
let hasUnsavedChanges = false;

// Export initialization function for tab system
window.initializeTemplateEditor = function ()
{
    if (canvas) return; // Already initialized

    // Load utilities first
    loadUtilities();

    canvas = document.getElementById('editor-canvas');
    ctx = canvas.getContext('2d');

    // Ensure stick structures are initialized properly
    if (!templateData.leftStick || typeof templateData.leftStick !== 'object')
    {
        templateData.leftStick = { joystickNumber: 1, buttons: [] };
    }
    if (!templateData.leftStick.buttons || !Array.isArray(templateData.leftStick.buttons))
    {
        templateData.leftStick.buttons = [];
    }

    if (!templateData.rightStick || typeof templateData.rightStick !== 'object')
    {
        templateData.rightStick = { joystickNumber: 2, buttons: [] };
    }
    if (!templateData.rightStick.buttons || !Array.isArray(templateData.rightStick.buttons))
    {
        templateData.rightStick.buttons = [];
    }

    initializeEventListeners();
    loadPersistedTemplate();

    // Update stick mapping display
    updateStickMappingDisplay();

    // Ensure canvas is sized after layout is complete
    requestAnimationFrame(() =>
    {
        resizeCanvas();
    });

    window.addEventListener('resize', resizeCanvas);
};

function initializeEventListeners()
{
    // Stick selector buttons
    document.getElementById('left-stick-btn').addEventListener('click', () => switchStick('left'));
    document.getElementById('right-stick-btn').addEventListener('click', () => switchStick('right'));

    document.getElementById('save-template-btn').addEventListener('click', saveTemplate);
    document.getElementById('load-template-btn').addEventListener('click', loadTemplate);

    // Sidebar controls
    document.getElementById('template-name').addEventListener('input', (e) =>
    {
        templateData.name = e.target.value;
        markAsChanged();
        if (window.updateTemplateIndicator)
        {
            window.updateTemplateIndicator(e.target.value);
        }
    });

    document.getElementById('joystick-model').addEventListener('input', (e) =>
    {
        templateData.joystickModel = e.target.value;
        markAsChanged();
    });

    document.getElementById('load-image-btn').addEventListener('click', loadImage);
    document.getElementById('image-type-select').addEventListener('change', onImageTypeChange);
    document.getElementById('image-flip-select').addEventListener('change', (e) =>
    {
        templateData.imageFlipped = e.target.value;
        markAsChanged();
        redraw();
    });
    document.getElementById('new-template-btn').addEventListener('click', newTemplate);
    document.getElementById('add-button-btn').addEventListener('click', startAddButton);
    document.getElementById('delete-button-btn').addEventListener('click', deleteSelectedButton);
    document.getElementById('clear-all-btn').addEventListener('click', clearAllButtons);
    document.getElementById('mirror-template-btn').addEventListener('click', mirrorTemplate);
    document.getElementById('change-joystick-number-btn').addEventListener('click', changeAllJoystickNumbers);

    // Template joystick mapping modal
    const configureJoysticksBtn = document.getElementById('configure-template-joysticks-btn');
    const templateJoyMappingClose = document.getElementById('template-joystick-mapping-close');
    const templateJoyMappingCancel = document.getElementById('template-joystick-mapping-cancel');
    const detectRightStickBtn = document.getElementById('detect-right-stick-btn');
    const detectLeftStickBtn = document.getElementById('detect-left-stick-btn');
    const templateJoyMappingSave = document.getElementById('template-joystick-mapping-save');

    if (configureJoysticksBtn) configureJoysticksBtn.addEventListener('click', openTemplateJoystickMappingModal);
    if (templateJoyMappingClose) templateJoyMappingClose.addEventListener('click', closeTemplateJoystickMappingModal);
    if (templateJoyMappingCancel) templateJoyMappingCancel.addEventListener('click', closeTemplateJoystickMappingModal);
    if (detectRightStickBtn) detectRightStickBtn.addEventListener('click', () => detectStick('right'));
    if (detectLeftStickBtn) detectLeftStickBtn.addEventListener('click', () => detectStick('left'));
    if (templateJoyMappingSave) templateJoyMappingSave.addEventListener('click', saveTemplateJoystickMapping);

    // Zoom controls
    document.getElementById('zoom-in-btn').addEventListener('click', () => zoomBy(0.1));
    document.getElementById('zoom-out-btn').addEventListener('click', () => zoomBy(-0.1));
    document.getElementById('zoom-fit-btn').addEventListener('click', fitToScreen);
    document.getElementById('zoom-reset-btn').addEventListener('click', resetZoom);    // Canvas events
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('dblclick', onCanvasDoubleClick);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('wheel', onCanvasWheel, { passive: false });

    // Global mouseup to catch releases outside canvas (fixes panning stuck bug)
    document.addEventListener('mouseup', onCanvasMouseUp);

    // Modal
    document.getElementById('button-modal-cancel').addEventListener('click', closeButtonModal);
    document.getElementById('button-modal-save').addEventListener('click', saveButtonDetails);
    document.getElementById('button-modal-delete').addEventListener('click', deleteCurrentButton);
    document.getElementById('button-modal-detect').addEventListener('click', startInputDetection);
    document.getElementById('button-type-select').addEventListener('change', onButtonTypeChange);

    // Hat detection buttons
    document.querySelectorAll('.hat-detect-btn').forEach(btn =>
    {
        btn.addEventListener('click', (e) =>
        {
            const direction = e.target.dataset.direction;
            startHatInputDetection(direction);
        });
    });

    // Hat clear buttons
    document.querySelectorAll('.hat-clear-btn').forEach(btn =>
    {
        btn.addEventListener('click', (e) =>
        {
            const direction = e.target.dataset.direction;
            clearHatDirection(direction);
        });
    });

    // Simple button clear button
    document.getElementById('button-modal-clear').addEventListener('click', clearSimpleButtonInput);

    // Hidden file inputs
    document.getElementById('image-file-input').addEventListener('change', onImageFileSelected);
}

function resizeCanvas()
{
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();

    // Set CSS size for display (doesn't affect internal resolution)
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    // Set internal resolution to match CSS size (with device pixel ratio for crisp rendering)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    // Note: We'll apply DPR scaling in redraw() to avoid accumulation

    console.log('Canvas resized:', rect.width, 'x', rect.height, '(DPR:', dpr + ')');

    redraw();
}

// Stick switching
function switchStick(stick)
{
    if (currentStick === stick) return;

    currentStick = stick;

    console.log('Switching to stick:', stick);
    console.log('Left stick buttons:', templateData.leftStick);
    console.log('Right stick buttons:', templateData.rightStick);

    // Update button states
    document.getElementById('left-stick-btn').classList.toggle('active', stick === 'left');
    document.getElementById('right-stick-btn').classList.toggle('active', stick === 'right');

    // Clear selection
    selectButton(null);

    // Update button list and redraw
    updateButtonList();
    redraw();
}

// Get current stick's button array
function getCurrentButtons()
{
    if (currentStick === 'left')
    {
        // Handle nested structure: { joystickNumber: 1, buttons: [...] }
        if (templateData.leftStick && typeof templateData.leftStick === 'object' && !Array.isArray(templateData.leftStick))
        {
            if (!Array.isArray(templateData.leftStick.buttons))
            {
                templateData.leftStick.buttons = [];
            }
            return templateData.leftStick.buttons;
        }
        // Handle flat array structure: [...]
        if (!Array.isArray(templateData.leftStick))
        {
            templateData.leftStick = [];
        }
        return templateData.leftStick;
    }
    else
    {
        // Handle nested structure: { joystickNumber: 2, buttons: [...] }
        if (templateData.rightStick && typeof templateData.rightStick === 'object' && !Array.isArray(templateData.rightStick))
        {
            if (!Array.isArray(templateData.rightStick.buttons))
            {
                templateData.rightStick.buttons = [];
            }
            return templateData.rightStick.buttons;
        }
        // Handle flat array structure: [...]
        if (!Array.isArray(templateData.rightStick))
        {
            templateData.rightStick = [];
        }
        return templateData.rightStick;
    }
}

// Set current stick's button array
function setCurrentButtons(buttons)
{
    if (currentStick === 'left')
    {
        // Handle nested structure
        if (templateData.leftStick && typeof templateData.leftStick === 'object' && !Array.isArray(templateData.leftStick))
        {
            templateData.leftStick.buttons = buttons;
        }
        else
        {
            templateData.leftStick = buttons;
        }
    }
    else
    {
        // Handle nested structure
        if (templateData.rightStick && typeof templateData.rightStick === 'object' && !Array.isArray(templateData.rightStick))
        {
            templateData.rightStick.buttons = buttons;
        }
        else
        {
            templateData.rightStick = buttons;
        }
    }
}

// New template
async function newTemplate()
{
    if ((templateData.name ||
        templateData.imagePath ||
        templateData.leftStick.buttons.length > 0 ||
        templateData.rightStick.buttons.length > 0) &&
        !await confirm('Start a new template? Any unsaved changes will be lost.'))
    {
        return;
    }

    // Reset all data
    templateData = {
        name: '',
        joystickModel: '',
        joystickNumber: 2,
        imagePath: '',
        imageDataUrl: null,
        imageFlipped: 'right',
        imageType: 'single',
        leftImagePath: '',
        leftImageDataUrl: null,
        rightImagePath: '',
        rightImageDataUrl: null,
        leftStick: { joystickNumber: 1, buttons: [] },
        rightStick: { joystickNumber: 2, buttons: [] }
    };

    // Reset UI
    document.getElementById('template-name').value = '';
    document.getElementById('joystick-model').value = '';
    updateStickMappingDisplay();
    document.getElementById('image-flip-select').value = 'right';
    document.getElementById('image-type-select').value = 'single';
    document.getElementById('image-info').textContent = '';

    // Hide overlay message
    document.getElementById('canvas-overlay').classList.remove('hidden');

    // Reset canvas
    loadedImage = null;
    currentStick = 'right';
    selectedButtonId = null;
    zoom = 1.0;
    pan = { x: 0, y: 0 };

    // Update UI
    switchStick('right');
    resizeCanvas();

    // Clear localStorage
    localStorage.removeItem('currentTemplate');
    localStorage.removeItem('templateFileName');
    hasUnsavedChanges = false;
    updateUnsavedIndicator();

    // Reset header template name
    if (window.updateTemplateIndicator)
    {
        window.updateTemplateIndicator('Untitled Template');
    }
}

// Handle image type selection
function onImageTypeChange()
{
    const imageType = document.getElementById('image-type-select').value;
    templateData.imageType = imageType;

    if (imageType === 'single')
    {
        // Single image mode - show mirror selector
        document.getElementById('image-flip-select').parentElement.style.display = 'block';
    }
    else
    {
        // Dual image mode - hide mirror selector
        document.getElementById('image-flip-select').parentElement.style.display = 'none';
        templateData.imageFlipped = 'none';
        document.getElementById('image-flip-select').value = 'none';
    }

    markAsChanged();
    updateButtonList();
    redraw();
}

// Image loading
async function loadImage()
{
    // If dual image mode, ask which stick to load for
    if (templateData.imageType === 'dual')
    {
        const stickChoice = await confirm('Load image for LEFT stick? (OK=Left, Cancel=Right)');
        if (stickChoice)
        {
            currentStick = 'left';
            document.getElementById('left-stick-btn').click();
        }
        else
        {
            currentStick = 'right';
            document.getElementById('right-stick-btn').click();
        }
    }

    document.getElementById('image-file-input').click();
}

function onImageFileSelected(e)
{
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) =>
    {
        const img = new Image();
        img.onload = () =>
        {
            // Handle based on image type
            if (templateData.imageType === 'dual')
            {
                // Store image for current stick
                if (currentStick === 'left')
                {
                    loadedImage = img;
                    templateData.leftImagePath = file.name;
                    templateData.leftImageDataUrl = event.target.result;
                    document.getElementById('image-info').textContent =
                        `Left: ${file.name} (${img.width}×${img.height})`;
                }
                else
                {
                    // For right stick in dual mode, we'll use a separate canvas setup
                    templateData.rightImagePath = file.name;
                    templateData.rightImageDataUrl = event.target.result;
                    document.getElementById('image-info').textContent =
                        `Right: ${file.name} (${img.width}×${img.height})`;
                    // Keep loadedImage as the left image, but we'll handle rendering both
                }
            }
            else
            {
                // Single image mode
                loadedImage = img;
                templateData.imagePath = file.name;
                templateData.imageDataUrl = event.target.result;
                document.getElementById('image-info').textContent =
                    `${file.name} (${img.width}×${img.height})`;
            }

            // Hide overlay
            document.getElementById('canvas-overlay').classList.add('hidden');

            // Ensure canvas is properly sized, then fit image to screen
            resizeCanvas();
            requestAnimationFrame(() =>
            {
                fitToScreen();
            });
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);

    // Clear the input so the same file can be loaded again
    e.target.value = '';
}

// Drawing functions
function redraw()
{
    if (!ctx) return;

    // Get canvas display size
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Get the image to display based on mode
    let displayImage = null;
    if (templateData.imageType === 'dual')
    {
        // In dual mode, load the appropriate image for current stick
        if (currentStick === 'left' && templateData.leftImageDataUrl)
        {
            if (!loadedImage || templateData.leftImagePath !== templateData.imagePath)
            {
                const img = new Image();
                img.onload = () => { loadedImage = img; redraw(); };
                img.src = templateData.leftImageDataUrl;
                return;
            }
            displayImage = loadedImage;
        }
        else if (currentStick === 'right' && templateData.rightImageDataUrl)
        {
            if (!loadedImage || templateData.rightImagePath !== templateData.imagePath)
            {
                const img = new Image();
                img.onload = () => { loadedImage = img; redraw(); };
                img.src = templateData.rightImageDataUrl;
                return;
            }
            displayImage = loadedImage;
        }
    }
    else
    {
        // Single image mode
        displayImage = loadedImage;
    }

    if (!displayImage) return;

    ctx.save();

    // Apply DPR scaling first (to work with physical pixels)
    ctx.scale(dpr, dpr);

    // Apply zoom and pan (in logical pixels)
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Enable smooth image rendering
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Draw image with optional flip based on current stick and imageFlipped setting
    ctx.save();
    const shouldFlip = templateData.imageFlipped !== 'none' && currentStick === templateData.imageFlipped;

    if (shouldFlip)
    {
        ctx.translate(displayImage.width, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(displayImage, 0, 0);
    ctx.restore();

    // Draw all buttons for current stick (without flip)
    const buttons = getCurrentButtons();
    console.log('Drawing buttons for', currentStick, ':', buttons.length, 'buttons');
    if (Array.isArray(buttons))
    {
        buttons.forEach(button =>
        {
            drawButton(button);
        });
    }

    // Draw temp button while placing
    if (tempButton)
    {
        drawButton(tempButton, true);
    }

    ctx.restore();
}

function drawButton(button, isTemp = false)
{
    const alpha = isTemp ? 0.7 : 1.0;
    const isHat = button.buttonType === 'hat4way';

    // Draw line connecting button to label
    if (button.labelPos)
    {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = isHat ? '#666' : '#d9534f';
        ctx.lineWidth = 1.5 / zoom;
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        ctx.beginPath();
        ctx.moveTo(button.buttonPos.x, button.buttonPos.y);
        ctx.lineTo(button.labelPos.x, button.labelPos.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    // Draw button position marker
    ctx.save();
    ctx.globalAlpha = alpha;
    const handleSize = (7 / zoom);
    ctx.fillStyle = isHat ? '#666' : '#d9534f';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    ctx.arc(button.buttonPos.x, button.buttonPos.y, handleSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Draw label box(es)
    if (button.labelPos)
    {
        if (isHat)
        {
            drawHat4WayLabels(button, alpha, handleSize);
        }
        else
        {
            drawSingleButtonLabel(button, alpha, handleSize);
        }
    }

    // Highlight if selected
    if (button.id === selectedButtonId && !isTemp)
    {
        ctx.save();
        ctx.strokeStyle = '#e67e72';
        ctx.lineWidth = 3;

        // Highlight the label box border
        if (button.labelPos)
        {
            const isHat = button.buttonType === 'hat4way';

            if (isHat)
            {
                // For hats, highlight the center push box
                const boxWidth = 70;
                const boxHeight = 50;
                const x = button.labelPos.x - boxWidth / 2;
                const y = button.labelPos.y - boxHeight / 2;

                roundRect(ctx, x, y, boxWidth, boxHeight, 4);
                ctx.stroke();
            }
            else
            {
                // For simple buttons, highlight the label box
                const labelWidth = 140;
                const labelHeight = 50;
                const x = button.labelPos.x - labelWidth / 2;
                const y = button.labelPos.y - labelHeight / 2;

                roundRect(ctx, x, y, labelWidth, labelHeight, 4);
                ctx.stroke();
            }
        }

        ctx.restore();
    }
}

function drawSingleButtonLabel(button, alpha, handleSize)
{
    ctx.save();
    ctx.globalAlpha = alpha;

    const labelWidth = 140;
    const labelHeight = 50;
    const x = button.labelPos.x - labelWidth / 2;
    const y = button.labelPos.y - labelHeight / 2;
    const radius = 4;

    // Box background with rounded corners
    ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;

    roundRect(ctx, x, y, labelWidth, labelHeight, radius);
    ctx.fill();
    ctx.stroke();

    // Button name
    const simplifiedName = simplifyButtonName(button.name || 'Button');
    ctx.fillStyle = '#ccc';
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(simplifiedName, button.labelPos.x, button.labelPos.y - 8);

    // "(unbound)" text
    ctx.fillStyle = '#666';
    ctx.font = 'italic 10px "Segoe UI", sans-serif';
    ctx.fillText('(unbound)', button.labelPos.x, button.labelPos.y + 10);

    ctx.restore();
}

function drawHat4WayLabels(button, alpha, handleSize)
{
    ctx.save();
    ctx.globalAlpha = alpha;

    const spacing = 45;
    const boxWidth = 70;
    const boxHeight = 50;
    const radius = 4;

    // Draw hat name above
    ctx.fillStyle = '#aaa';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const simplifiedName = simplifyButtonName(button.name || 'Hat');
    ctx.fillText(simplifiedName, button.labelPos.x, button.labelPos.y - spacing * 2 + 10);

    // Calculate positions for each direction in a plus pattern
    const positions = {
        'up': { x: button.labelPos.x, y: button.labelPos.y - spacing + 8, label: 'U' },
        'down': { x: button.labelPos.x, y: button.labelPos.y + spacing - 8, label: 'D' },
        'left': { x: button.labelPos.x - spacing * 1.5, y: button.labelPos.y, label: 'L' },
        'right': { x: button.labelPos.x + spacing * 1.5, y: button.labelPos.y, label: 'R' },
        'push': { x: button.labelPos.x, y: button.labelPos.y, label: 'Push' }
    };

    // Draw each direction box
    Object.keys(positions).forEach(dir =>
    {
        const pos = positions[dir];
        const x = pos.x - boxWidth / 2;
        const y = pos.y - boxHeight / 2;

        // Box background
        ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1.5 / zoom;

        roundRect(ctx, x, y, boxWidth, boxHeight, radius);
        ctx.fill();
        ctx.stroke();

        // Direction label
        ctx.fillStyle = '#ccc';
        ctx.font = `${11 / zoom}px 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pos.label, pos.x, pos.y - 6 / zoom);

        // "(unbound)" text
        ctx.fillStyle = '#666';
        ctx.font = `italic ${9 / zoom}px 'Segoe UI', sans-serif`;
        ctx.fillText('(unbound)', pos.x, pos.y + 8 / zoom);
    });

    ctx.restore();
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
    if (!name) return 'Button';

    // Remove "Joystick 1 - " or "Button Button" prefixes
    name = name.replace(/^Joystick \d+ - /, '');
    name = name.replace(/^Button /, '');

    // Simplify common patterns
    name = name.replace(/Button\((\d+)\)/, 'Btn $1');
    name = name.replace(/^(\d+)$/, 'Btn $1');

    return name;
}

// Canvas interaction
function getCanvasCoords(event)
{
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - pan.x) / zoom;
    const y = (event.clientY - rect.top - pan.y) / zoom;
    return { x, y };
}

function onCanvasMouseDown(event)
{
    if (!loadedImage) return;

    const coords = getCanvasCoords(event);

    // Middle click for panning
    if (event.button === 1)
    {
        isPanning = true;
        lastPanPosition = { x: event.clientX, y: event.clientY };
        canvas.style.cursor = 'grabbing';
        event.preventDefault();
        return;
    }

    // Only handle left click for button operations
    if (event.button !== 0) return;

    if (mode === 'view')
    {
        // Check if clicking on a handle
        const handle = findHandleAtPosition(coords);
        if (handle)
        {
            draggingHandle = handle;
            selectButton(handle.buttonId);
            return;
        }

        // Check if clicking on a button
        const button = findButtonAtPosition(coords);
        if (button)
        {
            selectButton(button.id);
        } else
        {
            selectButton(null);
        }
    } else if (mode === 'placing-button')
    {
        // Place the button position
        tempButton = {
            id: Date.now(),
            name: '',
            buttonPos: { ...coords },
            labelPos: null
        };
        mode = 'placing-label';
        redraw();
    } else if (mode === 'placing-label')
    {
        // Place the label position
        tempButton.labelPos = { ...coords };
        mode = 'view';
        redraw();

        // Open modal to get button name
        openButtonModal(tempButton);
    }
}

// Snap coordinate to grid
function snapToGrid(value, gridSize = SNAP_GRID)
{
    return Math.round(value / gridSize) * gridSize;
}

function onCanvasMouseMove(event)
{
    if (isPanning)
    {
        const deltaX = event.clientX - lastPanPosition.x;
        const deltaY = event.clientY - lastPanPosition.y;

        pan.x += deltaX;
        pan.y += deltaY;

        lastPanPosition = { x: event.clientX, y: event.clientY };
        redraw();
        return;
    }

    if (draggingHandle)
    {
        const coords = getCanvasCoords(event);
        const snappedCoords = {
            x: snapToGrid(coords.x),
            y: snapToGrid(coords.y)
        };
        const buttons = getCurrentButtons();
        const button = buttons.find(b => b.id === draggingHandle.buttonId);

        if (button)
        {
            if (draggingHandle.type === 'button')
            {
                button.buttonPos = { ...snappedCoords };
            } else if (draggingHandle.type === 'label')
            {
                button.labelPos = { ...snappedCoords };
            }
            markAsChanged();
            redraw();
        }
    }

    // Update cursor
    if (mode === 'placing-button' || mode === 'placing-label')
    {
        canvas.style.cursor = 'crosshair';
    } else if (draggingHandle)
    {
        canvas.style.cursor = 'move';
    } else
    {
        const coords = getCanvasCoords(event);
        const handle = findHandleAtPosition(coords);
        canvas.style.cursor = handle ? 'move' : 'default';
    }
}

function onCanvasMouseUp(event)
{
    if (isPanning)
    {
        isPanning = false;
        canvas.style.cursor = 'default';
    }

    draggingHandle = null;
}

function onCanvasWheel(event)
{
    event.preventDefault();

    const delta = -event.deltaY / 1000;
    zoomBy(delta, event);
}

function onCanvasDoubleClick(event)
{
    if (!loadedImage || mode !== 'view') return;

    const coords = getCanvasCoords(event);

    // Check if double-clicking on a button
    const button = findButtonAtPosition(coords);
    if (button)
    {
        editButtonFromList(button.id);
    }
}

function findHandleAtPosition(pos)
{
    const handleSize = 12 / zoom; // For button position markers
    const buttons = getCurrentButtons();

    for (const button of buttons)
    {
        // Check button position handle (keep the red dot)
        const distButton = Math.sqrt(
            Math.pow(pos.x - button.buttonPos.x, 2) +
            Math.pow(pos.y - button.buttonPos.y, 2)
        );
        if (distButton <= handleSize)
        {
            return { buttonId: button.id, type: 'button' };
        }

        // Check if clicking on label box area
        if (button.labelPos)
        {
            const isHat = button.buttonType === 'hat4way';

            if (isHat)
            {
                // For hats, check the entire plus arrangement area
                const spacing = 45;
                const boxWidth = 70;
                const boxHeight = 50;

                // Check each box in the plus pattern
                const positions = [
                    { x: button.labelPos.x, y: button.labelPos.y - spacing }, // up
                    { x: button.labelPos.x, y: button.labelPos.y + spacing }, // down
                    { x: button.labelPos.x - spacing, y: button.labelPos.y }, // left
                    { x: button.labelPos.x + spacing, y: button.labelPos.y }, // right
                    { x: button.labelPos.x, y: button.labelPos.y } // push
                ];

                for (const boxPos of positions)
                {
                    const x = boxPos.x - boxWidth / 2;
                    const y = boxPos.y - boxHeight / 2;

                    if (pos.x >= x && pos.x <= x + boxWidth &&
                        pos.y >= y && pos.y <= y + boxHeight)
                    {
                        return { buttonId: button.id, type: 'label' };
                    }
                }
            }
            else
            {
                // For simple buttons, check the single label box
                const labelWidth = 140 / zoom;
                const labelHeight = 40 / zoom;
                const x = button.labelPos.x - labelWidth / 2;
                const y = button.labelPos.y - labelHeight / 2;

                if (pos.x >= x && pos.x <= x + labelWidth &&
                    pos.y >= y && pos.y <= y + labelHeight)
                {
                    return { buttonId: button.id, type: 'label' };
                }
            }
        }
    }

    return null;
}

function findButtonAtPosition(pos)
{
    const handleSize = 12 / zoom;
    const buttons = getCurrentButtons();

    for (const button of buttons)
    {
        // Check if clicking near button position
        const dist = Math.sqrt(
            Math.pow(pos.x - button.buttonPos.x, 2) +
            Math.pow(pos.y - button.buttonPos.y, 2)
        );
        if (dist <= handleSize)
        {
            return button;
        }

        // Check if clicking on label box
        if (button.labelPos)
        {
            const labelWidth = 80;
            const labelHeight = 30;
            const x = button.labelPos.x - labelWidth / 2;
            const y = button.labelPos.y - labelHeight / 2;

            if (pos.x >= x && pos.x <= x + labelWidth &&
                pos.y >= y && pos.y <= y + labelHeight)
            {
                return button;
            }
        }
    }

    return null;
}

// Zoom functions
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

    updateZoomDisplay();
    redraw();
}

function resetZoom()
{
    if (!loadedImage) return;

    // Reset to 100% zoom
    zoom = 1.0;

    // Center image in canvas at actual size
    const scaledWidth = loadedImage.width * zoom;
    const scaledHeight = loadedImage.height * zoom;
    pan.x = (canvas.width - scaledWidth) / 2;
    pan.y = (canvas.height - scaledHeight) / 2;

    updateZoomDisplay();
    redraw();
}

function fitToScreen()
{
    if (!loadedImage) return;

    // Fit image to canvas with padding
    const padding = 80; // More generous padding for better visibility
    const availableWidth = canvas.width - (padding * 2);
    const availableHeight = canvas.height - (padding * 2);

    const scaleX = availableWidth / loadedImage.width;
    const scaleY = availableHeight / loadedImage.height;
    zoom = Math.min(scaleX, scaleY);

    // Clamp zoom to reasonable bounds
    zoom = Math.max(0.1, Math.min(5, zoom));

    // Center image in viewport
    const scaledWidth = loadedImage.width * zoom;
    const scaledHeight = loadedImage.height * zoom;
    pan.x = (canvas.width - scaledWidth) / 2;
    pan.y = (canvas.height - scaledHeight) / 2;

    updateZoomDisplay();
    redraw();
}

function updateZoomDisplay()
{
    document.getElementById('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

// Button management
async function startAddButton()
{
    if (!loadedImage)
    {
        const showAlert = window.showAlert || alert;
        await showAlert('Please load an image first', 'Load Image First');
        if (window.showAlert)
        {
            highlightLoadImageButton();
        }
        return;
    }

    // Check if current stick is mapped to a physical joystick
    const currentStickData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
    const stickName = currentStick === 'left' ? 'Left Stick' : 'Right Stick';
    const jsNum = currentStickData?.joystickNumber || (currentStick === 'left' ? 1 : 2);

    if (!currentStickData?.physicalJoystickId && currentStickData?.physicalJoystickId !== 0)
    {
        // Show message that they need to configure the joystick mapping first
        const showAlert = window.showAlert || alert;
        await showAlert(
            `Please configure the joystick mapping for the ${stickName} (js${jsNum}) before adding buttons.\n\n` +
            `Click "⚙️ Set Joystick Mapping" at the top of the page, then:\n` +
            `1. Click "Test" next to your physical ${stickName.toLowerCase()}\n` +
            `2. Press any button on that device to detect it\n` +
            `3. Select "${stickName}" from the dropdown\n` +
            `4. Click "Save Mapping"\n\n` +
            `Note: Your joystick may be detected as js1, js2, js3, etc. - any number is fine!`,
            'Configure Joystick Mapping Required'
        );

        // Highlight the configure button with animation - now that alert has resolved
        if (window.showAlert)
        {
            highlightConfigureButton();
        }
        return;
    }

    mode = 'placing-button';
    canvas.style.cursor = 'crosshair';
    selectButton(null);
}

function highlightConfigureButton()
{
    const configBtn = document.getElementById('configure-template-joysticks-btn');
    const mappingDisplay = document.getElementById('stick-mapping-display');

    if (!configBtn) return;

    // Add highlight animation class
    configBtn.classList.add('highlight-pulse');
    if (mappingDisplay) mappingDisplay.classList.add('highlight-pulse');

    // Scroll the button into view smoothly
    configBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Remove animation after 3 seconds
    setTimeout(() =>
    {
        configBtn.classList.remove('highlight-pulse');
        if (mappingDisplay) mappingDisplay.classList.remove('highlight-pulse');
    }, 3000);
}

function highlightLoadImageButton()
{
    const loadImageBtn = document.getElementById('load-image-btn');

    if (!loadImageBtn) return;

    // Add highlight animation class
    loadImageBtn.classList.add('highlight-pulse');

    // Scroll the button into view smoothly
    loadImageBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Remove animation after 3 seconds
    setTimeout(() =>
    {
        loadImageBtn.classList.remove('highlight-pulse');
    }, 3000);
}


function selectButton(buttonId)
{
    selectedButtonId = buttonId;

    // Update button list UI
    document.querySelectorAll('.button-item').forEach(item =>
    {
        if (parseInt(item.dataset.buttonId) === buttonId)
        {
            item.classList.add('selected');
        } else
        {
            item.classList.remove('selected');
        }
    });

    // Enable/disable delete button
    document.getElementById('delete-button-btn').disabled = (buttonId === null);

    redraw();
}

async function deleteSelectedButton(event)
{
    if (event)
    {
        event.preventDefault();
        event.stopPropagation();
    }

    if (selectedButtonId === null) return;

    // Find the button to get its name for the confirmation message
    const buttons = getCurrentButtons();
    const buttonToDelete = buttons.find(b => b.id === selectedButtonId);
    const buttonName = buttonToDelete ? buttonToDelete.name : 'Button';

    const showConfirmation = window.showConfirmation;
    if (!showConfirmation)
    {
        console.error('showConfirmation not available');
        return;
    }

    const confirmDelete = await showConfirmation(
        `Delete button "${buttonName}"?`,
        'Delete Button',
        'Delete',
        'Cancel'
    );

    if (!confirmDelete)
    {
        // User cancelled the deletion - do nothing
        return;
    }

    // Proceed with deletion
    const updatedButtons = buttons.filter(b => b.id !== selectedButtonId);
    setCurrentButtons(updatedButtons);
    selectedButtonId = null;

    markAsChanged();
    updateButtonList();
    redraw();
}

async function clearAllButtons()
{
    const buttons = getCurrentButtons();
    if (buttons.length === 0) return;


    const showConfirmation = window.showConfirmation;
    if (!showConfirmation)
    {
        console.error('showConfirmation not available');
        return;
    }

    const confirmed = await showConfirmation(
        'Are you sure you want to clear all buttons? This cannot be undone.',
        'Clear All Buttons',
        'Clear All',
        'Cancel',
        'btn-danger'
    );

    if (!confirmed) return;

    setCurrentButtons([]);
    selectedButtonId = null;
    markAsChanged();
    updateButtonList();
    redraw();
}

async function mirrorTemplate()
{
    if (!loadedImage)
    {
        await window.showAlert('Please load an image first', 'Load Image First');
        return;
    }

    if (templateData.imageFlipped === 'none')
    {
        await window.showAlert('Cannot mirror template in dual image mode or when mirroring is disabled', 'Mirror Disabled');
        return;
    }

    // Show custom confirmation with direction options
    const stickName = currentStick === 'left' ? 'Left' : 'Right';
    const otherStick = currentStick === 'left' ? 'Right' : 'Left';

    const confirmed = await window.showConfirmation(
        `Mirror ${stickName} stick buttons to ${otherStick} stick?\n\nThis will copy and flip all button positions for the current stick to the other stick horizontally.`,
        'Mirror Template',
        `Mirror ${stickName} → ${otherStick}`,
        'Cancel',
        'btn-secondary'
    );

    if (!confirmed)
    {
        return;
    }

    // Determine source and destination sticks
    const sourceStick = currentStick;
    const sourceData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
    const destStick = currentStick === 'left' ? 'right' : 'left';
    const destData = currentStick === 'left' ? templateData.rightStick : templateData.leftStick;

    // Mirror all button positions from source to destination
    const imageWidth = loadedImage.width;
    const sourceButtons = sourceData.buttons;

    // Create mirrored copies of all buttons
    const mirroredButtons = sourceButtons.map(button =>
    {
        const mirroredButton = JSON.parse(JSON.stringify(button)); // Deep copy
        mirroredButton.id = Date.now() + Math.random(); // Give new unique ID

        // Mirror button position
        mirroredButton.buttonPos.x = imageWidth - mirroredButton.buttonPos.x;

        // Mirror label position
        if (mirroredButton.labelPos)
        {
            mirroredButton.labelPos.x = imageWidth - mirroredButton.labelPos.x;
        }

        return mirroredButton;
    });

    // Replace destination stick buttons with mirrored copies
    destData.buttons = mirroredButtons;

    markAsChanged();

    // Switch to destination stick to show the mirrored result
    switchStick(destStick);

    await window.showAlert(
        `Successfully mirrored ${stickName} stick buttons to ${otherStick} stick!`,
        'Mirror Complete'
    );
}


async function changeAllJoystickNumbers()
{
    // Get current stick data
    const currentStickData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
    const buttons = currentStickData.buttons;

    if (buttons.length === 0)
    {
        await window.showAlert('No buttons in current view to update', 'No Buttons');
        return;
    }

    // Get current joystick number and toggle it
    const currentJsNum = currentStickData.joystickNumber || 1;
    const targetJsNum = currentJsNum === 1 ? 2 : 1;

    const confirmed = await window.showConfirmation(
        `Change all button joystick numbers in ${currentStick} stick from js${currentJsNum} to js${targetJsNum}?`,
        'Change Joystick Numbers',
        'Change',
        'Cancel'
    );

    if (!confirmed)
    {
        return;
    }

    // Update the stick's joystick number
    currentStickData.joystickNumber = targetJsNum;

    // Update all button inputs in the current stick
    buttons.forEach(button =>
    {
        if (button.inputs)
        {
            Object.keys(button.inputs).forEach(key =>
            {
                const input = button.inputs[key];
                if (typeof input === 'string')
                {
                    // Replace the old js number with the new one
                    button.inputs[key] = input.replace(/^js[1-2]_/, `js${targetJsNum}_`);
                }
            });
        }
    });

    markAsChanged();
    updateButtonList();
    redraw();

    await window.showAlert(
        `All buttons in ${currentStick} stick updated to use joystick ${targetJsNum}!`,
        'Update Complete'
    );
}

function updateButtonList()
{
    const listEl = document.getElementById('button-list');
    const buttons = getCurrentButtons();

    if (buttons.length === 0)
    {
        listEl.innerHTML = '<div class="empty-state-small">No buttons added yet</div>';
        document.getElementById('delete-button-btn').disabled = true;
        return;
    }

    let html = '';
    buttons.forEach(button =>
    {
        let inputInfo = '';

        // Handle new structure with buttonType and inputs
        if (button.buttonType === 'hat4way' && button.inputs)
        {
            const directions = [];
            if (button.inputs.up) directions.push('↑');
            if (button.inputs.down) directions.push('↓');
            if (button.inputs.left) directions.push('←');
            if (button.inputs.right) directions.push('→');
            if (button.inputs.push) directions.push('⬇');
            inputInfo = ` - Hat (${directions.join(' ')})`;
        }
        else if (button.inputs && button.inputs.main)
        {
            // Simple button with new structure
            const input = button.inputs.main;
            if (input.type === 'button')
            {
                inputInfo = ` - Button ${input.id}`;
            }
            else if (input.type === 'axis')
            {
                inputInfo = ` - Axis ${input.id}`;
            }
        }
        // Legacy support for old structure
        else if (button.inputType && button.inputId !== undefined)
        {
            if (button.inputType === 'button')
            {
                inputInfo = ` - Button ${button.inputId}`;
            }
            else if (button.inputType === 'axis')
            {
                inputInfo = ` - Axis ${button.inputId}`;
            }
            else if (button.inputType === 'hat')
            {
                inputInfo = ` - Hat ${button.inputId}`;
            }
        }

        html += `
      <div class="button-item ${button.id === selectedButtonId ? 'selected' : ''}" 
           data-button-id="${button.id}"
           onclick="selectButtonFromList(${button.id})"
           ondblclick="editButtonFromList(${button.id})">
        <div class="button-item-name">${button.name || 'Unnamed Button'}${inputInfo}</div>
        <div class="button-item-coords">
          Button: (${Math.round(button.buttonPos.x)}, ${Math.round(button.buttonPos.y)})
          ${button.labelPos ? `<br>Label: (${Math.round(button.labelPos.x)}, ${Math.round(button.labelPos.y)})` : ''}
        </div>
      </div>
    `;
    });

    listEl.innerHTML = html;
}

window.selectButtonFromList = function (buttonId)
{
    selectButton(buttonId);
};

window.editButtonFromList = function (buttonId)
{
    const buttons = getCurrentButtons();
    const button = buttons.find(b => b.id === buttonId);
    if (!button) return;

    // Store original button data for cancel functionality
    originalButton = button;
    // Create a deep copy for editing
    tempButton = JSON.parse(JSON.stringify(button));

    // Open modal with current values
    document.getElementById('button-modal').style.display = 'flex';
    document.getElementById('button-name-input').value = button.name || '';

    // Set button type
    const buttonType = button.buttonType || 'simple';
    document.getElementById('button-type-select').value = buttonType;
    onButtonTypeChange(); // Update UI sections

    // Load buttonId for simple buttons
    if (buttonType === 'simple')
    {
        const buttonIdDisplay = document.getElementById('button-id-display');
        const fullIdDisplay = document.getElementById('button-full-id-display');

        // Get joystick number from current stick
        const currentStickData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
        const jsNum = (currentStickData && currentStickData.joystickNumber) || templateData.joystickNumber || 1;

        if (button.buttonId !== undefined && button.buttonId !== null)
        {
            buttonIdDisplay.textContent = button.buttonId;
            fullIdDisplay.textContent = `js${jsNum}_button${button.buttonId}`;
        }
        else if (button.inputs && button.inputs.main)
        {
            // Handle both new format (object with id) and legacy format (string)
            const main = button.inputs.main;
            if (typeof main === 'object' && main.id !== undefined)
            {
                buttonIdDisplay.textContent = main.id;
                fullIdDisplay.textContent = `js${jsNum}_button${main.id}`;
            }
            else if (typeof main === 'string')
            {
                // Extract button number from string like "js1_button3"
                const match = main.match(/button(\d+)/);
                if (match)
                {
                    buttonIdDisplay.textContent = match[1];
                    fullIdDisplay.textContent = `js${jsNum}_button${match[1]}`;
                }
                else
                {
                    buttonIdDisplay.textContent = '—';
                    fullIdDisplay.textContent = '—';
                }
            }
            else
            {
                buttonIdDisplay.textContent = '—';
                fullIdDisplay.textContent = '—';
            }
        }
        else
        {
            buttonIdDisplay.textContent = '—';
            fullIdDisplay.textContent = '—';
        }
    }
    // If it's a hat, populate the detected inputs
    else if (buttonType === 'hat4way' && button.inputs)
    {
        updateHatDetectionButtons(button.inputs);
        // Get joystick number for full ID display
        const currentStickData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
        const jsNum = (currentStickData && currentStickData.joystickNumber) || templateData.joystickNumber || 1;

        // Display hat direction IDs with full ID strings
        if (button.inputs.up && button.inputs.up.id !== undefined)
        {
            document.querySelector('[data-direction="up"].hat-id-display').textContent = `${button.inputs.up.id} (js${jsNum}_button${button.inputs.up.id})`;
        }
        if (button.inputs.down && button.inputs.down.id !== undefined)
        {
            document.querySelector('[data-direction="down"].hat-id-display').textContent = `${button.inputs.down.id} (js${jsNum}_button${button.inputs.down.id})`;
        }
        if (button.inputs.left && button.inputs.left.id !== undefined)
        {
            document.querySelector('[data-direction="left"].hat-id-display').textContent = `${button.inputs.left.id} (js${jsNum}_button${button.inputs.left.id})`;
        }
        if (button.inputs.right && button.inputs.right.id !== undefined)
        {
            document.querySelector('[data-direction="right"].hat-id-display').textContent = `${button.inputs.right.id} (js${jsNum}_button${button.inputs.right.id})`;
        }
        if (button.inputs.push && button.inputs.push.id !== undefined)
        {
            document.querySelector('[data-direction="push"].hat-id-display').textContent = `${button.inputs.push.id} (js${jsNum}_button${button.inputs.push.id})`;
        }
    }
    else
    {
        resetHatDetectionButtons();
    }

    document.getElementById('button-name-input').focus();

    // Allow Enter to save
    const input = document.getElementById('button-name-input');
    const enterHandler = (e) =>
    {
        if (e.key === 'Enter')
        {
            saveButtonDetails();
            input.removeEventListener('keypress', enterHandler);
        }
    };
    input.addEventListener('keypress', enterHandler);
};

// Button modal
function openButtonModal(button)
{
    document.getElementById('button-modal').style.display = 'flex';
    document.getElementById('button-name-input').value = button.name || '';

    // Default to simple button type
    document.getElementById('button-type-select').value = 'simple';
    onButtonTypeChange();

    // Clear buttonId display for new buttons
    document.getElementById('button-id-display').textContent = '—';
    document.getElementById('button-full-id-display').textContent = '—';

    // Reset hat detection buttons and displays
    resetHatDetectionButtons();
    document.querySelectorAll('.hat-id-display').forEach(display => display.textContent = '—');

    // Clear any pending timeouts from previous detection session
    if (inputDetectionTimeout !== null)
    {
        clearTimeout(inputDetectionTimeout);
        inputDetectionTimeout = null;
    }

    if (hatDetectionTimeout !== null)
    {
        clearTimeout(hatDetectionTimeout);
        hatDetectionTimeout = null;
    }

    // Reset input detection status display
    document.getElementById('input-detection-status').style.display = 'none';
    document.getElementById('input-detection-status').textContent = '';
    document.getElementById('input-detection-status').style.color = '';

    // Reset hat detection status display
    document.getElementById('hat-detection-status').style.display = 'none';
    document.getElementById('hat-detection-status').textContent = '';
    document.getElementById('hat-detection-status').style.color = '';

    // Reset detectingInput flag
    detectingInput = false;

    document.getElementById('button-name-input').focus();

    // Allow Enter to save
    const input = document.getElementById('button-name-input');
    const enterHandler = (e) =>
    {
        if (e.key === 'Enter')
        {
            saveButtonDetails();
            input.removeEventListener('keypress', enterHandler);
        }
    };
    input.addEventListener('keypress', enterHandler);
}

function closeButtonModal()
{
    // Stop any active input detection
    if (detectingInput)
    {
        stopInputDetection();
    }

    document.getElementById('button-modal').style.display = 'none';

    // Only cancel if this was a new button being placed
    if (tempButton && mode === 'placing-label')
    {
        tempButton = null;
        mode = 'view';
        redraw();
    }

    // Clear references (changes are discarded if user canceled)
    tempButton = null;
    originalButton = null;
}

async function saveButtonDetails()
{
    const name = document.getElementById('button-name-input').value.trim();

    if (!name)
    {
        await alert('Please enter a button name');
        return;
    }

    if (tempButton)
    {
        tempButton.name = name;

        const buttonType = document.getElementById('button-type-select').value;
        tempButton.buttonType = buttonType;

        // Save buttonId for simple buttons
        if (buttonType === 'simple')
        {
            // For simple buttons, keep existing buttonId if it was already set
            // It's display-only now, set only through auto-detection
            if (!tempButton.inputs)
            {
                tempButton.inputs = {};
            }
        }
        // Save hat direction IDs
        else if (buttonType === 'hat4way')
        {
            if (!tempButton.inputs)
            {
                tempButton.inputs = {};
            }

            // Hat IDs are set only through auto-detection, so we just preserve what was already set
            // The inputs object is already populated by the detection process
        }

        // Check if this is a new button or editing an existing one
        const buttons = getCurrentButtons();
        const existingIndex = buttons.findIndex(b => b.id === tempButton.id);
        if (existingIndex === -1)
        {
            // New button - add to current stick
            buttons.push(tempButton);
            setCurrentButtons(buttons);
        }
        else
        {
            // Editing existing button - copy all properties from tempButton to originalButton
            if (originalButton)
            {
                Object.assign(originalButton, tempButton);
            }
        }

        markAsChanged();
        selectButton(tempButton.id);
        tempButton = null;
        originalButton = null;
    }

    updateButtonList();
    redraw();
    closeButtonModal();
}

// Delete button from modal
async function deleteCurrentButton(event)
{
    if (event)
    {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!tempButton)
    {
        console.warn('deleteCurrentButton called but tempButton is null');
        return;
    }

    // Check if button still exists BEFORE showing confirmation
    const buttonsBeforeConfirm = getCurrentButtons();
    const indexBeforeConfirm = buttonsBeforeConfirm.findIndex(b => b.id === tempButton.id);

    console.log('Delete button clicked. Button exists:', indexBeforeConfirm !== -1);
    console.log('Buttons count before confirm:', buttonsBeforeConfirm.length);

    if (indexBeforeConfirm === -1)
    {
        await alert('Error: This button has already been deleted!');
        closeButtonModal();
        tempButton = null;
        updateButtonList();
        redraw();
        return;
    }

    // Import showConfirmation from main.js (available globally via window)
    const showConfirmation = window.showConfirmation;
    if (!showConfirmation)
    {
        console.error('showConfirmation not available');
        return;
    }

    const confirmDelete = await showConfirmation(
        `Delete button "${tempButton.name}"?`,
        'Delete Button',
        'Delete',
        'Cancel'
    );

    console.log('Confirm dialog returned:', confirmDelete);

    if (!confirmDelete)
    {
        // User cancelled the deletion - do nothing and keep modal open
        console.log('User CANCELLED deletion - button should NOT be deleted');
        return;
    }

    console.log('User CONFIRMED deletion - proceeding with delete');

    // Proceed with deletion - verify button still exists (check again in case something changed)
    const buttons = getCurrentButtons();
    const index = buttons.findIndex(b => b.id === tempButton.id);

    console.log('After confirm - Button exists:', index !== -1);

    if (index !== -1)
    {
        buttons.splice(index, 1);
        setCurrentButtons(buttons);
        markAsChanged();
        console.log('Button deleted successfully');
    }
    else
    {
        console.warn('Button was deleted between confirmation and deletion!');
    }

    // Clear references and close modal
    selectButton(null);
    tempButton = null;
    updateButtonList();
    redraw();
    closeButtonModal();
}

// Button type change handler
function onButtonTypeChange()
{
    const buttonType = document.getElementById('button-type-select').value;

    // Show/hide appropriate input sections
    if (buttonType === 'simple')
    {
        document.getElementById('simple-input-section').style.display = 'block';
        document.getElementById('hat-input-section').style.display = 'none';
    }
    else if (buttonType === 'hat4way')
    {
        document.getElementById('simple-input-section').style.display = 'none';
        document.getElementById('hat-input-section').style.display = 'block';

        // Initialize inputs object if needed
        if (tempButton && !tempButton.inputs)
        {
            tempButton.inputs = {};
        }
    }

    // Update tempButton type
    if (tempButton)
    {
        tempButton.buttonType = buttonType;
    }
}

// Hat switch input detection
async function startHatInputDetection(direction)
{
    if (detectingInput)
    {
        return;
    }

    detectingInput = true;
    const btn = document.querySelector(`[data-direction="${direction}"]`);
    const originalText = btn.textContent;
    btn.textContent = 'Detecting...';
    btn.disabled = true;

    document.getElementById('hat-detection-status').textContent = `Press ${direction}...`;
    document.getElementById('hat-detection-status').style.display = 'block';
    document.getElementById('hat-detection-status').style.color = '';

    // Generate unique session ID for this detection
    const thisSessionId = Date.now() + Math.random();
    currentHatDetectionSessionId = thisSessionId;
    console.log('[HAT-DETECTION] Starting hat detection session:', thisSessionId, 'for direction:', direction);

    try
    {
        const result = await invoke('wait_for_input_binding', {
            timeoutSecs: 10,
            sessionId: thisSessionId.toString()
        });

        // Check if this session is still active
        if (currentHatDetectionSessionId !== thisSessionId)
        {
            console.log('[HAT-DETECTION] Session', thisSessionId, 'cancelled, ignoring result');
            return;
        }

        if (result)
        {
            console.log('[HAT-DETECTION] Session', thisSessionId, 'detected input for', direction, ':', result);
            console.log('Input string:', result.input_string);

            // The Rust backend now returns proper Star Citizen format
            // Examples: "js1_hat1_up", "js1_button3", "js2_axis2"

            // Get the current stick's configuration
            const currentStickData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
            const templateJsNum = (currentStickData && currentStickData.joystickNumber) || templateData.joystickNumber || 1;
            const detectedJsNumber = currentStickData?.detectedJsNumber;

            // Extract the actual js number from the detected input
            const inputMatch = result.input_string.match(/^(js|gp)(\d+)_/);
            const actualJsNum = inputMatch ? parseInt(inputMatch[2]) : null;

            // Validate that input is from the configured device (if configured)
            if (detectedJsNumber && actualJsNum && actualJsNum !== detectedJsNumber)
            {
                console.warn(`Input from js${actualJsNum} but expected js${detectedJsNumber}`);
                const stickName = currentStick === 'left' ? 'Left Stick' : 'Right Stick';
                const otherStickName = currentStick === 'left' ? 'Right Stick' : 'Left Stick';
                document.getElementById('hat-detection-status').textContent =
                    `⚠️ That input is from a device not mapped to the ${stickName}. It may be mapped to the ${otherStickName} or not configured. Switch sticks or reconfigure your joystick mapping.`;
                document.getElementById('hat-detection-status').style.color = '#f0ad4e';
                return;
            }

            let adjustedInputString = result.input_string;

            // Replace jsX_ with the current stick's template joystick number (js1 or js2)
            adjustedInputString = adjustedInputString.replace(/^(js|gp)\d+_/, `js${templateJsNum}_`);
            console.log('Adjusted input string for', direction, '(remapped to template js number):', adjustedInputString);

            // Store the adjusted Star Citizen input string in tempButton
            if (tempButton)
            {
                if (!tempButton.inputs)
                {
                    tempButton.inputs = {};
                }

                // Store the complete SC format string (e.g., "js1_hat1_up" or "js1_button15")
                tempButton.inputs[direction] = adjustedInputString;

                // Update display to show the detected input
                const match = adjustedInputString.match(/button(\d+)/);
                if (match)
                {
                    const buttonId = parseInt(match[1]);
                    const display = document.querySelector(`[data-direction="${direction}"].hat-id-display`);
                    if (display)
                    {
                        display.textContent = `${buttonId} (${adjustedInputString})`;
                    }
                }
                else
                {
                    // For hat inputs, just show the full string
                    const display = document.querySelector(`[data-direction="${direction}"].hat-id-display`);
                    if (display)
                    {
                        display.textContent = adjustedInputString;
                    }
                }
            }

            // Use shared utility for display name
            const displayText = parseInputShortName(result.input_string);

            // Update button to show it's detected
            btn.textContent = `✓ (${displayText})`;

            document.getElementById('hat-detection-status').textContent = `${direction}: ${result.display_name}`;
            document.getElementById('hat-detection-status').style.color = '#5cb85c';

            // Clear any existing timeout
            if (hatDetectionTimeout !== null)
            {
                clearTimeout(hatDetectionTimeout);
            }

            hatDetectionTimeout = setTimeout(() =>
            {
                document.getElementById('hat-detection-status').style.display = 'none';
                detectingInput = false; // Clear the flag after the timeout
                hatDetectionTimeout = null;
            }, 2000);
        }
        else
        {
            btn.textContent = originalText;
            document.getElementById('hat-detection-status').textContent = 'Timeout - try again';
            document.getElementById('hat-detection-status').style.color = '#d9534f';
        }
    }
    catch (error)
    {
        console.error('Error detecting input:', error);
        btn.textContent = originalText;
        document.getElementById('hat-detection-status').textContent = `Error: ${error}`;
        document.getElementById('hat-detection-status').style.color = '#d9534f';
    }
    finally
    {
        // Only clear session if this was the active session
        if (currentHatDetectionSessionId === thisSessionId)
        {
            console.log('[HAT-DETECTION] Cleaning up session:', thisSessionId);
            currentHatDetectionSessionId = null;
        }
        detectingInput = false;
        btn.disabled = false;
    }
}

// Joystick Input Detection
async function startInputDetection()
{
    if (detectingInput)
    {
        stopInputDetection();
        return;
    }

    detectingInput = true;
    document.getElementById('button-modal-detect').textContent = 'Detecting...';
    document.getElementById('button-modal-detect').classList.add('btn-primary');
    document.getElementById('button-modal-detect').disabled = true;
    document.getElementById('input-detection-status').textContent = 'Press any button or move any axis on your joystick...';
    document.getElementById('input-detection-status').style.display = 'block';

    // Generate unique session ID for this detection
    const thisSessionId = Date.now() + Math.random();
    currentDetectionSessionId = thisSessionId;
    console.log('[INPUT-DETECTION] Starting detection session:', thisSessionId);

    try
    {
        // Use the Rust backend to detect input (10 second timeout)
        const result = await invoke('wait_for_input_binding', {
            timeoutSecs: 10,
            sessionId: thisSessionId.toString()
        });

        // Check if this session is still active
        if (currentDetectionSessionId !== thisSessionId)
        {
            console.log('[INPUT-DETECTION] Session', thisSessionId, 'cancelled, ignoring result');
            return;
        }

        if (result)
        {
            console.log('[INPUT-DETECTION] Session', thisSessionId, 'detected input:', result);
            console.log('Input string:', result.input_string);

            // The Rust backend now returns proper Star Citizen format
            // Examples: "js1_hat1_up", "js1_button3", "js2_axis2"

            // Get the current stick's configuration
            const currentStickData = currentStick === 'left' ? templateData.leftStick : templateData.rightStick;
            const templateJsNum = (currentStickData && currentStickData.joystickNumber) || templateData.joystickNumber || 1;
            const detectedJsNumber = currentStickData?.detectedJsNumber;

            // Extract the actual js number from the detected input
            const inputMatch = result.input_string.match(/^(js|gp)(\d+)_/);
            const actualJsNum = inputMatch ? parseInt(inputMatch[2]) : null;

            // Validate that input is from the configured device (if configured)
            if (detectedJsNumber && actualJsNum && actualJsNum !== detectedJsNumber)
            {
                console.warn(`Input from js${actualJsNum} but expected js${detectedJsNumber}`);
                const stickName = currentStick === 'left' ? 'Left Stick' : 'Right Stick';
                const otherStickName = currentStick === 'left' ? 'Right Stick' : 'Left Stick';
                document.getElementById('input-detection-status').textContent =
                    `⚠️ That input is from a device not mapped to the ${stickName}. It may be mapped to the ${otherStickName} or not configured. Switch sticks or reconfigure your joystick mapping.`;
                document.getElementById('input-detection-status').style.color = '#f0ad4e';
                return;
            }

            let adjustedInputString = result.input_string;

            // Replace jsX_ with the current stick's template joystick number (js1 or js2)
            adjustedInputString = adjustedInputString.replace(/^(js|gp)\d+_/, `js${templateJsNum}_`);
            console.log('Adjusted input string (remapped to template js number):', adjustedInputString);

            // Use shared utility for friendly name (use adjusted string)
            const inputName = parseInputDisplayName(adjustedInputString);

            // Update the input field with a friendly name
            document.getElementById('button-name-input').value = inputName;

            // Store the adjusted Star Citizen format string in tempButton
            if (tempButton)
            {
                tempButton.buttonType = 'simple';
                tempButton.name = inputName;

                // Extract button ID if it's a button
                const match = adjustedInputString.match(/button(\d+)/);
                if (match)
                {
                    const buttonId = parseInt(match[1]);
                    tempButton.buttonId = buttonId;

                    // Store the full SC input string (e.g., "js1_button3")
                    tempButton.inputs = {
                        main: adjustedInputString
                    };

                    // Update the displays
                    document.getElementById('button-id-display').textContent = buttonId;
                    document.getElementById('button-full-id-display').textContent = adjustedInputString;
                }
            }

            // Show confirmation
            document.getElementById('input-detection-status').textContent = `Detected: ${result.display_name}`;
            document.getElementById('input-detection-status').style.color = '#5cb85c';

            // Clear any existing timeout
            if (inputDetectionTimeout !== null)
            {
                clearTimeout(inputDetectionTimeout);
            }

            inputDetectionTimeout = setTimeout(() =>
            {
                document.getElementById('input-detection-status').style.display = 'none';
                document.getElementById('input-detection-status').style.color = '';
                detectingInput = false; // Clear the flag after the timeout
                inputDetectionTimeout = null;
            }, 2000);
        }
        else
        {
            // Timeout
            document.getElementById('input-detection-status').textContent = 'No input detected - timed out';
            document.getElementById('input-detection-status').style.color = '#d9534f';

            // Clear any existing timeout
            if (inputDetectionTimeout !== null)
            {
                clearTimeout(inputDetectionTimeout);
            }

            inputDetectionTimeout = setTimeout(() =>
            {
                document.getElementById('input-detection-status').style.display = 'none';
                document.getElementById('input-detection-status').style.color = '';
                inputDetectionTimeout = null;
            }, 3000);
        }
    }
    catch (error)
    {
        console.error('Error detecting input:', error);
        document.getElementById('input-detection-status').textContent = `Error: ${error}`;
        document.getElementById('input-detection-status').style.color = '#d9534f';
    }
    finally
    {
        // Only clear session if this was the active session
        if (currentDetectionSessionId === thisSessionId)
        {
            console.log('[INPUT-DETECTION] Cleaning up session:', thisSessionId);
            currentDetectionSessionId = null;
        }
        detectingInput = false;
        document.getElementById('button-modal-detect').textContent = '🎮 Detect Input';
        document.getElementById('button-modal-detect').classList.remove('btn-primary');
        document.getElementById('button-modal-detect').disabled = false;
    }
}

function stopInputDetection()
{
    // Clear any pending timeouts
    if (inputDetectionTimeout !== null)
    {
        clearTimeout(inputDetectionTimeout);
        inputDetectionTimeout = null;
    }

    if (hatDetectionTimeout !== null)
    {
        clearTimeout(hatDetectionTimeout);
        hatDetectionTimeout = null;
    }

    // Clear session IDs to invalidate any pending operations
    console.log('[INPUT-DETECTION] Stopping detection, clearing sessions');
    currentDetectionSessionId = null;
    currentHatDetectionSessionId = null;

    detectingInput = false;
    document.getElementById('button-modal-detect').textContent = '🎮 Detect Input';
    document.getElementById('button-modal-detect').classList.remove('btn-primary');
    document.getElementById('button-modal-detect').disabled = false;
    document.getElementById('input-detection-status').style.display = 'none';
}

// Clear simple button input
function clearSimpleButtonInput()
{
    if (!tempButton) return;

    tempButton.inputs = {};
    tempButton.buttonId = undefined;
    document.getElementById('button-id-display').textContent = '—';
    document.getElementById('button-full-id-display').textContent = '—';
    document.getElementById('input-detection-status').style.display = 'none';

    markAsChanged();
}

// Clear hat direction input
function clearHatDirection(direction)
{
    if (!tempButton) return;

    if (tempButton.inputs)
    {
        delete tempButton.inputs[direction];
    }

    const display = document.querySelector(`[data-direction="${direction}"].hat-id-display`);
    if (display)
    {
        display.textContent = '—';
    }

    const btn = document.querySelector(`[data-direction="${direction}"].hat-detect-btn`);
    if (btn)
    {
        const direction_label = direction.charAt(0).toUpperCase() + direction.slice(1);
        const emoji = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️', push: '⬇️' }[direction];
        btn.textContent = `${emoji} Detect ${direction_label}`;
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
    }

    markAsChanged();
}

// Template save/load
async function saveTemplate()
{
    if (!templateData.name)
    {
        await alert('Please enter a template name');
        document.getElementById('template-name').focus();
        return;
    }

    if (!loadedImage)
    {
        await alert('Please load a joystick image');
        return;
    }

    // For dual image mode, require both images
    if (templateData.imageType === 'dual')
    {
        if (!templateData.leftImageDataUrl || !templateData.rightImageDataUrl)
        {
            await alert('Please load images for both left and right sticks');
            return;
        }
    }

    // Count buttons from nested structure
    const leftButtons = getCurrentButtons();
    const rightButtons = currentStick === 'left' ?
        (templateData.rightStick.buttons || templateData.rightStick || []) :
        (templateData.leftStick.buttons || templateData.leftStick || []);
    const totalButtons = leftButtons.length + (Array.isArray(rightButtons) ? rightButtons.length : 0);

    if (totalButtons === 0)
    {
        await alert('Please add at least one button to either stick');
        return;
    }

    try
    {
        let resourceDir;
        try
        {
            resourceDir = await invoke('get_resource_dir');
        }
        catch (e)
        {
            console.warn('Could not get resource directory:', e);
            resourceDir = undefined;
        }

        const filePath = await save({
            filters: [{
                name: 'Joystick Template',
                extensions: ['json']
            }],
            defaultPath: resourceDir ? `${resourceDir}/${templateData.name.replace(/[^a-z0-9]/gi, '_')}.json` : `${templateData.name.replace(/[^a-z0-9]/gi, '_')}.json`
        });

        if (!filePath) return; // User cancelled

        // Helper to extract buttons array from stick (handles nested or flat structure)
        const getStickButtons = (stick) =>
        {
            if (Array.isArray(stick)) return stick;
            if (stick && stick.buttons && Array.isArray(stick.buttons)) return stick.buttons;
            return [];
        };

        // Prepare data for saving with nested structure
        const saveData = {
            name: templateData.name,
            joystickModel: templateData.joystickModel,
            imagePath: templateData.imagePath,
            imageDataUrl: templateData.imageDataUrl,
            imageFlipped: templateData.imageFlipped, // 'left', 'right', or 'none'
            imageType: templateData.imageType, // 'single' or 'dual'
            leftImagePath: templateData.leftImagePath,
            leftImageDataUrl: templateData.leftImageDataUrl,
            rightImagePath: templateData.rightImagePath,
            rightImageDataUrl: templateData.rightImageDataUrl,
            imageWidth: loadedImage.width,
            imageHeight: loadedImage.height,
            leftStick: {
                joystickNumber: templateData.leftStick.joystickNumber || 1,
                buttons: getStickButtons(templateData.leftStick).map(b => ({
                    id: b.id,
                    name: b.name,
                    buttonPos: b.buttonPos,
                    labelPos: b.labelPos,
                    buttonType: b.buttonType || 'simple',
                    inputs: b.inputs || {},
                    // Legacy support
                    inputType: b.inputType,
                    inputId: b.inputId
                }))
            },
            rightStick: {
                joystickNumber: templateData.rightStick.joystickNumber || 2,
                buttons: getStickButtons(templateData.rightStick).map(b => ({
                    id: b.id,
                    name: b.name,
                    buttonPos: b.buttonPos,
                    labelPos: b.labelPos,
                    buttonType: b.buttonType || 'simple',
                    inputs: b.inputs || {},
                    // Legacy support
                    inputType: b.inputType,
                    inputId: b.inputId
                }))
            }
        };

        await invoke('save_template', {
            filePath,
            templateJson: JSON.stringify(saveData, null, 2)
        });

        // Persist to localStorage
        localStorage.setItem('currentTemplate', JSON.stringify(saveData));
        localStorage.setItem('templateFileName', filePath.split(/[\\\/]/).pop());

        // Clear unsaved changes
        hasUnsavedChanges = false;
        updateUnsavedIndicator();

        // Update header template name
        if (window.updateTemplateIndicator)
        {
            window.updateTemplateIndicator(templateData.name);
        }

        await alert('Template saved successfully!');
    } catch (error)
    {
        console.error('Error saving template:', error);
        await alert(`Failed to save template: ${error}`);
    }
}

async function loadTemplate()
{
    try
    {
        let defaultPath;
        try
        {
            defaultPath = await invoke('get_resource_dir');
        }
        catch (e)
        {
            console.warn('Could not get resource directory:', e);
        }

        const filePath = await open({
            filters: [{
                name: 'Joystick Template',
                extensions: ['json']
            }],
            multiple: false,
            defaultPath: defaultPath
        });

        if (!filePath) return; // User cancelled

        const templateJson = await invoke('load_template', { filePath });
        const data = JSON.parse(templateJson);

        // Load the data - handle both old and new formats
        templateData.name = data.name || '';
        templateData.joystickModel = data.joystickModel || '';
        templateData.joystickNumber = data.joystickNumber || 1;
        templateData.imagePath = data.imagePath || '';
        templateData.imageDataUrl = data.imageDataUrl || null;

        // Handle imageType (new field)
        templateData.imageType = data.imageType || 'single';

        // Handle dual image data
        templateData.leftImagePath = data.leftImagePath || '';
        templateData.leftImageDataUrl = data.leftImageDataUrl || null;
        templateData.rightImagePath = data.rightImagePath || '';
        templateData.rightImageDataUrl = data.rightImageDataUrl || null;

        // Handle imageFlipped: convert old boolean format to new format
        if (typeof data.imageFlipped === 'boolean')
        {
            // Old format: true means flipped, assume it was for left stick
            templateData.imageFlipped = data.imageFlipped ? 'left' : 'right';
        }
        else
        {
            // New format: 'left', 'right', or 'none'
            templateData.imageFlipped = data.imageFlipped || 'right';
        }

        // Handle buttons: support multiple formats
        // Format 1: New nested format { leftStick: { joystickNumber: 1, buttons: [...] }, rightStick: { joystickNumber: 2, buttons: [...] } }
        // Format 2: Flat array format { leftStick: [...], rightStick: [...] }
        // Format 3: Old single stick format { buttons: [...] }

        if (data.leftStick || data.rightStick)
        {
            // New dual stick format (nested or flat)
            templateData.leftStick = data.leftStick || { joystickNumber: 1, buttons: [] };
            templateData.rightStick = data.rightStick || { joystickNumber: 2, buttons: [] };

            // Ensure nested structure has buttons array
            if (templateData.leftStick && typeof templateData.leftStick === 'object' && !Array.isArray(templateData.leftStick) && !templateData.leftStick.buttons)
            {
                templateData.leftStick.buttons = [];
            }
            if (templateData.rightStick && typeof templateData.rightStick === 'object' && !Array.isArray(templateData.rightStick) && !templateData.rightStick.buttons)
            {
                templateData.rightStick.buttons = [];
            }
        }
        else if (data.buttons)
        {
            // Old single stick format - put all buttons in right stick by default
            templateData.leftStick = { joystickNumber: 1, buttons: [] };
            templateData.rightStick = { joystickNumber: 2, buttons: data.buttons || [] };
        }
        else
        {
            // No buttons at all
            templateData.leftStick = { joystickNumber: 1, buttons: [] };
            templateData.rightStick = { joystickNumber: 2, buttons: [] };
        }

        // Persist to localStorage
        localStorage.setItem('currentTemplate', JSON.stringify(data));
        localStorage.setItem('templateFileName', filePath.split(/[\\\/]/).pop());

        // Reset unsaved changes
        hasUnsavedChanges = false;
        updateUnsavedIndicator();

        // Update header template name
        console.log('loadTemplate - data.name:', data.name);
        console.log('window.updateTemplateIndicator exists:', typeof window.updateTemplateIndicator);
        if (window.updateTemplateIndicator)
        {
            console.log('Calling updateTemplateIndicator with:', data.name || 'Untitled Template');
            window.updateTemplateIndicator(data.name || 'Untitled Template');
        }
        else
        {
            console.log('window.updateTemplateIndicator is not available');
        }

        // Update UI
        document.getElementById('template-name').value = templateData.name;
        document.getElementById('joystick-model').value = templateData.joystickModel;
        updateStickMappingDisplay();
        document.getElementById('image-type-select').value = templateData.imageType;
        document.getElementById('image-flip-select').value = templateData.imageFlipped;

        // Update UI visibility based on image type
        if (templateData.imageType === 'dual')
        {
            document.getElementById('image-flip-select').parentElement.style.display = 'none';
        }
        else
        {
            document.getElementById('image-flip-select').parentElement.style.display = 'block';
        }

        // Load the image(s)
        if (templateData.imageType === 'dual')
        {
            // Load dual images
            if (templateData.leftImageDataUrl)
            {
                const img = new Image();
                img.src = templateData.leftImageDataUrl;
            }
            if (templateData.rightImageDataUrl)
            {
                const img = new Image();
                img.src = templateData.rightImageDataUrl;
            }
            document.getElementById('image-info').textContent =
                `Left: ${templateData.leftImagePath}, Right: ${templateData.rightImagePath}`;

            // Load the left image first for display
            if (templateData.leftImageDataUrl)
            {
                const img = new Image();
                img.onload = () =>
                {
                    loadedImage = img;
                    document.getElementById('canvas-overlay').classList.add('hidden');
                    resizeCanvas();
                    requestAnimationFrame(() =>
                    {
                        fitToScreen();
                        updateButtonList();
                    });
                };
                img.src = templateData.leftImageDataUrl;
            }
        }
        else
        {
            // Single image mode
            if (templateData.imageDataUrl)
            {
                const img = new Image();
                img.onload = () =>
                {
                    loadedImage = img;
                    document.getElementById('canvas-overlay').classList.add('hidden');
                    document.getElementById('image-info').textContent =
                        `${templateData.imagePath} (${img.width}×${img.height})`;
                    resizeCanvas();
                    requestAnimationFrame(() =>
                    {
                        fitToScreen();
                        updateButtonList();
                    });
                };
                img.src = templateData.imageDataUrl;
            }
        }

    } catch (error)
    {
        console.error('Error loading template:', error);
        await alert(`Failed to load template: ${error}`);
    }
}

// Helper functions for hat detection buttons
function resetHatDetectionButtons()
{
    document.querySelectorAll('.hat-detect-btn').forEach(btn =>
    {
        const direction = btn.dataset.direction;
        const emoji = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️', push: '⬇️' }[direction];
        btn.textContent = `${emoji} Detect ${direction.charAt(0).toUpperCase() + direction.slice(1)}`;
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
    });
    document.getElementById('hat-detection-status').style.display = 'none';
}

function updateHatDetectionButtons(inputs)
{
    Object.keys(inputs).forEach(direction =>
    {
        const input = inputs[direction];
        const btn = document.querySelector(`[data-direction="${direction}"].hat-detect-btn`);
        if (btn && input)
        {
            const emoji = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️', push: '⬇️' }[direction];

            // Handle both string format (js1_button3) and object format ({id: 3})
            let displayText = '';
            if (typeof input === 'string')
            {
                displayText = parseInputShortName(input);
            }
            else if (typeof input === 'object' && input.id !== undefined)
            {
                displayText = `Btn ${input.id}`;
            }
            else
            {
                return; // Skip if we can't parse it
            }

            btn.textContent = `${emoji} ✓ (${displayText})`;
        }
    });
}

function updateFileIndicator()
{
    const indicator = document.getElementById('loaded-file-indicator');
    const fileNameEl = document.getElementById('loaded-file-name');
    const savedPath = localStorage.getItem('keybindingsFilePath');

    if (indicator && fileNameEl && savedPath)
    {
        const fileName = savedPath.split(/[\\\\/]/).pop();
        fileNameEl.textContent = fileName;
        indicator.style.display = 'flex';
    }
}

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

function loadPersistedTemplate()
{
    try
    {
        const savedTemplate = localStorage.getItem('currentTemplate');
        if (savedTemplate)
        {
            const data = JSON.parse(savedTemplate);

            // Load the data
            templateData.name = data.name || '';
            templateData.joystickModel = data.joystickModel || '';
            templateData.joystickNumber = data.joystickNumber || 1;
            templateData.imagePath = data.imagePath || '';
            templateData.imageDataUrl = data.imageDataUrl || null;

            // Handle imageType
            templateData.imageType = data.imageType || 'single';

            // Handle dual image data
            templateData.leftImagePath = data.leftImagePath || '';
            templateData.leftImageDataUrl = data.leftImageDataUrl || null;
            templateData.rightImagePath = data.rightImagePath || '';
            templateData.rightImageDataUrl = data.rightImageDataUrl || null;

            // Handle imageFlipped: convert old boolean format to new format
            if (typeof data.imageFlipped === 'boolean')
            {
                templateData.imageFlipped = data.imageFlipped ? 'left' : 'right';
            }
            else
            {
                templateData.imageFlipped = data.imageFlipped || 'right';
            }

            // Handle buttons: support multiple formats
            // Format 1: New nested format { leftStick: { joystickNumber: 1, buttons: [...] }, rightStick: { joystickNumber: 2, buttons: [...] } }
            // Format 2: Flat array format { leftStick: [...], rightStick: [...] }
            // Format 3: Old single stick format { buttons: [...] }

            if (data.leftStick || data.rightStick)
            {
                // New dual stick format (nested or flat)
                templateData.leftStick = data.leftStick || { joystickNumber: 1, buttons: [] };
                templateData.rightStick = data.rightStick || { joystickNumber: 2, buttons: [] };

                // Ensure nested structure has buttons array
                if (templateData.leftStick && typeof templateData.leftStick === 'object' && !Array.isArray(templateData.leftStick) && !templateData.leftStick.buttons)
                {
                    templateData.leftStick.buttons = [];
                }
                if (templateData.rightStick && typeof templateData.rightStick === 'object' && !Array.isArray(templateData.rightStick) && !templateData.rightStick.buttons)
                {
                    templateData.rightStick.buttons = [];
                }
            }
            else if (data.buttons)
            {
                // Old single stick format - put all buttons in right stick by default
                templateData.leftStick = { joystickNumber: 1, buttons: [] };
                templateData.rightStick = { joystickNumber: 2, buttons: data.buttons || [] };
            }
            else
            {
                // No buttons at all
                templateData.leftStick = { joystickNumber: 1, buttons: [] };
                templateData.rightStick = { joystickNumber: 2, buttons: [] };
            }

            // Update UI
            document.getElementById('template-name').value = templateData.name;
            document.getElementById('joystick-model').value = templateData.joystickModel;
            updateStickMappingDisplay();
            document.getElementById('image-type-select').value = templateData.imageType;
            document.getElementById('image-flip-select').value = templateData.imageFlipped;

            // Update UI visibility based on image type
            if (templateData.imageType === 'dual')
            {
                document.getElementById('image-flip-select').parentElement.style.display = 'none';
            }
            else
            {
                document.getElementById('image-flip-select').parentElement.style.display = 'block';
            }

            // Load the image(s)
            if (templateData.imageType === 'dual')
            {
                // Load the left image for display
                if (templateData.leftImageDataUrl)
                {
                    const img = new Image();
                    img.onload = () =>
                    {
                        loadedImage = img;
                        document.getElementById('canvas-overlay').classList.add('hidden');
                        document.getElementById('image-info').textContent =
                            `Left: ${templateData.leftImagePath}, Right: ${templateData.rightImagePath}`;
                        resizeCanvas();
                        requestAnimationFrame(() =>
                        {
                            fitToScreen();
                            updateButtonList();
                        });
                    };
                    img.src = templateData.leftImageDataUrl;
                }
            }
            else
            {
                // Single image mode
                if (templateData.imageDataUrl)
                {
                    const img = new Image();
                    img.onload = () =>
                    {
                        loadedImage = img;
                        document.getElementById('canvas-overlay').classList.add('hidden');
                        document.getElementById('image-info').textContent =
                            `${templateData.imagePath} (${img.width}×${img.height})`;
                        resizeCanvas();
                        requestAnimationFrame(() =>
                        {
                            fitToScreen();
                            updateButtonList();
                        });
                    };
                    img.src = templateData.imageDataUrl;
                }
            }
        }
    } catch (error)
    {
        console.error('Error loading persisted template:', error);
    }
}

function markAsChanged()
{
    hasUnsavedChanges = true;
    updateUnsavedIndicator();

    // Also persist to localStorage for recovery
    try
    {
        localStorage.setItem('currentTemplate', JSON.stringify(templateData));
    } catch (error)
    {
        console.error('Error persisting template changes:', error);
    }
}

// ============================================================================
// TEMPLATE JOYSTICK MAPPING
// ============================================================================

let currentDetectingStick = null; // 'left' or 'right'
let detectionSessionId = null;

async function openTemplateJoystickMappingModal()
{
    const modal = document.getElementById('template-joystick-mapping-modal');
    modal.style.display = 'flex';

    // Update the display to show current mappings
    updateStickInfoDisplay();
}

function closeTemplateJoystickMappingModal()
{
    const modal = document.getElementById('template-joystick-mapping-modal');
    modal.style.display = 'none';

    // Stop any active detection
    if (currentDetectingStick !== null)
    {
        stopStickDetection();
    }
}

async function detectStick(stick)
{
    // If already detecting this stick, stop it
    if (currentDetectingStick === stick)
    {
        stopStickDetection();
        return;
    }

    // Stop any other detection first
    if (currentDetectingStick !== null)
    {
        stopStickDetection();
    }

    currentDetectingStick = stick;
    const buttonId = stick === 'right' ? 'detect-right-stick-btn' : 'detect-left-stick-btn';
    const infoId = stick === 'right' ? 'right-stick-info' : 'left-stick-info';

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
        infoDiv.innerHTML = '<div style="color: #ffc107; font-weight: 500;">👂 Listening... Press any button on your joystick!</div>';
    }

    // Generate session ID
    detectionSessionId = 'stick-detect-' + Date.now();
    const sessionId = detectionSessionId;

    try
    {
        console.log(`[STICK-DETECTION] Detecting ${stick} stick, session:`, sessionId);

        const result = await invoke('wait_for_input_binding', {
            sessionId: sessionId,
            timeoutSecs: 15
        });

        // Check if this session is still active
        if (detectionSessionId !== sessionId)
        {
            console.log(`[STICK-DETECTION] Session ${sessionId} cancelled, ignoring result`);
            return;
        }

        if (result)
        {
            console.log(`[STICK-DETECTION] Detected input:`, result);

            // Extract js number and device info
            const match = result.input_string.match(/^(js|gp)(\d+)_/);
            if (match)
            {
                const prefix = match[1];
                const jsNumber = parseInt(match[2]);

                // Get device name from backend (we'll use the input string for now)
                const deviceName = result.display_name || `Device ${jsNumber}`;

                // Store the mapping
                const stickData = stick === 'right' ? templateData.rightStick : templateData.leftStick;
                const targetJsNum = stick === 'right' ? 1 : 2; // Right = js1, Left = js2

                stickData.detectedJsNumber = jsNumber;
                stickData.detectedPrefix = prefix;
                stickData.joystickNumber = targetJsNum;
                stickData.physicalJoystickName = deviceName;
                stickData.physicalJoystickId = jsNumber; // Use js number as ID for now

                console.log(`[STICK-DETECTION] Mapped ${stick} stick: ${prefix}${jsNumber} → js${targetJsNum}`);

                // Update display
                if (infoDiv)
                {
                    infoDiv.classList.remove('detecting');
                    infoDiv.classList.add('configured');
                    infoDiv.innerHTML = `
                        <div class="device-name">${deviceName}</div>
                        <div class="device-details">Detected as: ${prefix}${jsNumber}</div>
                        <div class="device-mapping">Maps to: js${targetJsNum} (${stick === 'right' ? 'Right' : 'Left'} Stick)</div>
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
                    updateStickInfoDisplay();
                }, 3000);
            }
        }
    }
    catch (error)
    {
        console.error('[STICK-DETECTION] Error:', error);
        if (infoDiv)
        {
            infoDiv.classList.remove('detecting');
            infoDiv.innerHTML = `<div style="color: #d9534f;">❌ Error: ${error.message || error}</div>`;

            setTimeout(() =>
            {
                updateStickInfoDisplay();
            }, 3000);
        }
    }
    finally
    {
        // Reset button
        if (button)
        {
            const btnId = stick === 'right' ? 'detect-right-stick-btn' : 'detect-left-stick-btn';
            const btn = document.getElementById(btnId);
            if (btn)
            {
                btn.textContent = stick === 'right' ? '🎮 Detect Right Stick' : '🎮 Detect Left Stick';
                btn.classList.remove('detecting');
            }
        }

        if (currentDetectingStick === stick)
        {
            currentDetectingStick = null;
        }
        detectionSessionId = null;
    }
}

function stopStickDetection()
{
    if (currentDetectingStick === null) return;

    console.log(`[STICK-DETECTION] Stopping detection for ${currentDetectingStick}`);

    const buttonId = currentDetectingStick === 'right' ? 'detect-right-stick-btn' : 'detect-left-stick-btn';
    const button = document.getElementById(buttonId);

    if (button)
    {
        button.textContent = currentDetectingStick === 'right' ? '🎮 Detect Right Stick' : '🎮 Detect Left Stick';
        button.classList.remove('detecting');
    }

    updateStickInfoDisplay();

    currentDetectingStick = null;
    detectionSessionId = null;
}

function updateStickInfoDisplay()
{
    // Update right stick info
    const rightInfo = document.getElementById('right-stick-info');
    if (rightInfo)
    {
        const rightStick = templateData.rightStick;
        if (rightStick?.physicalJoystickName && rightStick?.detectedJsNumber)
        {
            rightInfo.classList.add('configured');
            rightInfo.classList.remove('detecting');
            rightInfo.innerHTML = `
                <div class="device-name">${rightStick.physicalJoystickName}</div>
                <div class="device-details">Detected as: ${rightStick.detectedPrefix || 'js'}${rightStick.detectedJsNumber}</div>
                <div class="device-mapping">Maps to: js1 (Right Stick)</div>
            `;
        }
        else
        {
            rightInfo.classList.remove('configured', 'detecting');
            rightInfo.innerHTML = '<div class="not-configured">Not configured</div>';
        }
    }

    // Update left stick info
    const leftInfo = document.getElementById('left-stick-info');
    if (leftInfo)
    {
        const leftStick = templateData.leftStick;
        if (leftStick?.physicalJoystickName && leftStick?.detectedJsNumber)
        {
            leftInfo.classList.add('configured');
            leftInfo.classList.remove('detecting');
            leftInfo.innerHTML = `
                <div class="device-name">${leftStick.physicalJoystickName}</div>
                <div class="device-details">Detected as: ${leftStick.detectedPrefix || 'js'}${leftStick.detectedJsNumber}</div>
                <div class="device-mapping">Maps to: js2 (Left Stick)</div>
            `;
        }
        else
        {
            leftInfo.classList.remove('configured', 'detecting');
            leftInfo.innerHTML = '<div class="not-configured">Not configured</div>';
        }
    }
}

async function saveTemplateJoystickMapping()
{
    // Validate: need at least one stick assigned
    const hasRightStick = templateData.rightStick?.detectedJsNumber;
    const hasLeftStick = templateData.leftStick?.detectedJsNumber;

    if (!hasRightStick && !hasLeftStick)
    {
        await alert('Please detect at least one joystick before saving.');
        return;
    }

    console.log('Saved template joystick mapping:', {
        leftStick: templateData.leftStick,
        rightStick: templateData.rightStick
    });

    markAsChanged();
    updateStickMappingDisplay();
    closeTemplateJoystickMappingModal();
}

function updateStickMappingDisplay()
{
    const leftDisplay = document.getElementById('left-stick-mapping');
    const rightDisplay = document.getElementById('right-stick-mapping');

    if (rightDisplay)
    {
        if (templateData.rightStick?.physicalJoystickName && templateData.rightStick?.detectedJsNumber)
        {
            const detectedNum = templateData.rightStick.detectedJsNumber;
            const prefix = templateData.rightStick.detectedPrefix || 'js';
            rightDisplay.textContent = `${templateData.rightStick.physicalJoystickName} (${prefix}${detectedNum} → js1)`;
            rightDisplay.style.color = '#5cb85c';
        }
        else
        {
            rightDisplay.textContent = 'Not configured';
            rightDisplay.style.color = '#999';
        }
    }

    if (leftDisplay)
    {
        if (templateData.leftStick?.physicalJoystickName && templateData.leftStick?.detectedJsNumber)
        {
            const detectedNum = templateData.leftStick.detectedJsNumber;
            const prefix = templateData.leftStick.detectedPrefix || 'js';
            leftDisplay.textContent = `${templateData.leftStick.physicalJoystickName} (${prefix}${detectedNum} → js2)`;
            leftDisplay.style.color = '#5cb85c';
        }
        else
        {
            leftDisplay.textContent = 'Not configured';
            leftDisplay.style.color = '#999';
        }
    }
}