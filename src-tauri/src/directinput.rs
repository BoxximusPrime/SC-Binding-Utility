use serde::Serialize;
use gilrs::{Gilrs, EventType, Button, Axis};
use std::time::{Duration, Instant};
use tauri::Emitter;

// Get currently pressed modifiers using Windows API
#[cfg(windows)]
fn get_active_modifiers() -> Vec<String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LMENU, VK_RMENU, VK_LCONTROL, VK_RCONTROL, VK_LSHIFT, VK_RSHIFT};
    
    let mut modifiers = Vec::new();
    
    unsafe {
        // Check if the high-order bit is set (key is pressed)
        // GetAsyncKeyState returns a SHORT where the most significant bit indicates current state
        if GetAsyncKeyState(VK_LMENU.0 as i32) as u16 & 0x8000 != 0 {
            modifiers.push("LALT".to_string());
        }
        if GetAsyncKeyState(VK_RMENU.0 as i32) as u16 & 0x8000 != 0 {
            modifiers.push("RALT".to_string());
        }
        if GetAsyncKeyState(VK_LCONTROL.0 as i32) as u16 & 0x8000 != 0 {
            modifiers.push("LCTRL".to_string());
        }
        if GetAsyncKeyState(VK_RCONTROL.0 as i32) as u16 & 0x8000 != 0 {
            modifiers.push("RCTRL".to_string());
        }
        if GetAsyncKeyState(VK_LSHIFT.0 as i32) as u16 & 0x8000 != 0 {
            modifiers.push("LSHIFT".to_string());
        }
        if GetAsyncKeyState(VK_RSHIFT.0 as i32) as u16 & 0x8000 != 0 {
            modifiers.push("RSHIFT".to_string());
        }
    }
    
    modifiers
}

// Stub for non-Windows platforms
#[cfg(not(windows))]
fn get_active_modifiers() -> Vec<String> {
    Vec::new()
}

#[derive(Serialize, Clone, Debug)]
pub struct DetectedInput {
    pub input_string: String,  // Star Citizen format like "js1_button3", "js1_hat1_up", or "js1_axis1_positive"
    pub display_name: String,
    pub device_type: String,
    pub axis_value: Option<f32>,  // Raw axis value if applicable
    pub modifiers: Vec<String>,  // Active modifiers: LALT, RALT, LCTRL, RCTRL, LSHIFT, RSHIFT
    pub is_modifier: bool,       // True if this input itself is a modifier key
    pub session_id: String,      // Session ID to track which detection session this input belongs to
}

#[derive(Serialize, Clone, Debug)]
pub struct DetectionComplete {
    pub session_id: String,
}

#[derive(Serialize)]
pub struct JoystickInfo {
    pub id: usize,
    pub name: String,
    pub is_connected: bool,
    pub button_count: usize,
    pub axis_count: usize,
    pub hat_count: usize,
}

use std::collections::HashMap;

// Axis state tracking to prevent duplicate detections
struct AxisState {
    last_value: f32,
    last_triggered_direction: Option<bool>, // true = positive, false = negative
}

/// Wait for joystick input using gilrs with hat detection and axis direction support
pub fn wait_for_input(session_id: String, timeout_secs: u64) -> Result<Option<DetectedInput>, String> {
    let mut gilrs = Gilrs::new().map_err(|e| e.to_string())?;
    
    // Track axis states to prevent duplicate triggers
    let mut axis_states: HashMap<(usize, u32), AxisState> = HashMap::new();
    
    // Pre-initialize all axes to their current state to prevent false triggers on startup
    for (_id, gamepad) in gilrs.gamepads() {
        let joystick_id = usize::from(gamepad.id());
        
        // Initialize all known axes
        for axis_idx in 1..=6 {
            let axis = match axis_idx {
                1 => Some(Axis::LeftStickX),
                2 => Some(Axis::LeftStickY),
                3 => Some(Axis::RightStickX),
                4 => Some(Axis::RightStickY),
                5 => Some(Axis::LeftZ),
                6 => Some(Axis::RightZ),
                _ => None,
            };
            
            if let Some(axis) = axis {
                let value = gamepad.axis_data(axis).map(|a| a.value()).unwrap_or(0.0);
                axis_states.insert(
                    (joystick_id, axis_idx),
                    AxisState {
                        last_value: value,
                        last_triggered_direction: None,
                    },
                );
            }
        }
    }
    
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    
    // Axis detection thresholds
    const AXIS_TRIGGER_THRESHOLD: f32 = 0.5;  // 50% deflection to trigger
    const AXIS_RESET_THRESHOLD: f32 = 0.3;    // 30% to reset (hysteresis)

    while start.elapsed() < timeout {
        while let Some(event) = gilrs.next_event_blocking(Some(Duration::from_millis(50))) {
            match event.event {
                EventType::ButtonPressed(button, code) => {
                    let joystick_id: usize = event.id.into();
                    let sc_instance = joystick_id + 1; // 1-based indexing for Star Citizen
                    
                    // First check if this is a known DPad button
                    let (input_string, display_name) = match button {
                        Button::DPadUp => (
                            format!("js{}_hat1_up", sc_instance),
                            format!("Joystick {} - Hat 1 UP", sc_instance)
                        ),
                        Button::DPadDown => (
                            format!("js{}_hat1_down", sc_instance),
                            format!("Joystick {} - Hat 1 DOWN", sc_instance)
                        ),
                        Button::DPadLeft => (
                            format!("js{}_hat1_left", sc_instance),
                            format!("Joystick {} - Hat 1 LEFT", sc_instance)
                        ),
                        Button::DPadRight => (
                            format!("js{}_hat1_right", sc_instance),
                            format!("Joystick {} - Hat 1 RIGHT", sc_instance)
                        ),
                        _ => {
                            // Regular button - extract the button index from the Code
                            // The Code debug format is: Code(EvCode { kind: Button, index: N })
                            // We need to parse out just the index number
                            let code_str = format!("{:?}", code);
                            
                            // Extract button number from debug string like "Code(EvCode { kind: Button, index: 1 })"
                            let button_index = if let Some(start) = code_str.find("index: ") {
                                let rest = &code_str[start + 7..];
                                if let Some(end) = rest.find(' ') {
                                    rest[..end].parse::<u32>().unwrap_or(0) + 1 // +1 for 1-based indexing
                                } else {
                                    0
                                }
                            } else {
                                0
                            };
                            
                            if button_index > 0 {
                                (
                                    format!("js{}_button{}", sc_instance, button_index),
                                    format!("Joystick {} - Button {}", sc_instance, button_index)
                                )
                            } else {
                                // Fallback if parsing fails
                                (
                                    format!("js{}_button_unknown", sc_instance),
                                    format!("Joystick {} - Button Unknown", sc_instance)
                                )
                            }
                        }
                    };
                    
                    return Ok(Some(DetectedInput {
                        input_string,
                        display_name,
                        device_type: "Joystick".to_string(),
                        axis_value: None,
                        modifiers: get_active_modifiers(),
                        is_modifier: false,
                        session_id: session_id.clone(),
                    }));
                }
                EventType::AxisChanged(axis, value, code) => {
                    let joystick_id: usize = event.id.into();
                    let sc_instance = joystick_id + 1; // 1-based indexing for Star Citizen
                    
                    // Extract axis index from the Code debug representation
                    let code_str = format!("{:?}", code);
                    let axis_index = if let Some(start) = code_str.find("index: ") {
                        let rest = &code_str[start + 7..];
                        if let Some(end) = rest.find(' ') {
                            rest[..end].parse::<u32>().unwrap_or(0) + 1 // +1 for 1-based indexing
                        } else {
                            0
                        }
                    } else {
                        0
                    };
                    
                    if axis_index > 0 {
                        let axis_key = (joystick_id, axis_index);
                        
                        // Get or create axis state
                        let state = axis_states.entry(axis_key).or_insert(AxisState {
                            last_value: value, // Initialize with current value instead of 0
                            last_triggered_direction: None,
                        });
                        
                        // Calculate how much the axis has moved from its initial/last value
                        let movement_delta = (value - state.last_value).abs();
                        
                        // Require significant movement from initial position (prevents false triggers)
                        const MOVEMENT_THRESHOLD: f32 = 0.3; // Require 30% movement from starting position
                        
                        // Determine if this is a significant movement
                        let is_positive = value > AXIS_TRIGGER_THRESHOLD;
                        let is_negative = value < -AXIS_TRIGGER_THRESHOLD;
                        let is_centered = value.abs() < AXIS_RESET_THRESHOLD;
                        let has_moved_enough = movement_delta > MOVEMENT_THRESHOLD;
                        
                        // Reset state if axis returns to center
                        if is_centered {
                            state.last_triggered_direction = None;
                            state.last_value = value;
                        }
                        
                        // Only trigger if:
                        // 1. Axis moved beyond threshold
                        // 2. Axis has moved significantly from its starting position
                        // 3. This direction hasn't been triggered yet
                        let should_trigger_positive = is_positive && has_moved_enough && state.last_triggered_direction != Some(true);
                        let should_trigger_negative = is_negative && has_moved_enough && state.last_triggered_direction != Some(false);
                        
                        if should_trigger_positive || should_trigger_negative {
                            let direction = if should_trigger_positive { "positive" } else { "negative" };
                            let direction_symbol = if should_trigger_positive { "+" } else { "-" };
                            
                            // Update state
                            state.last_triggered_direction = Some(should_trigger_positive);
                            state.last_value = value;
                            
                            // Get friendly axis name
                            let axis_name = match axis {
                                Axis::LeftStickX => "Left Stick X",
                                Axis::LeftStickY => "Left Stick Y",
                                Axis::RightStickX => "Right Stick X",
                                Axis::RightStickY => "Right Stick Y",
                                Axis::LeftZ => "Left Z",
                                Axis::RightZ => "Right Z",
                                _ => "Axis",
                            };
                            
                            return Ok(Some(DetectedInput {
                                input_string: format!("js{}_axis{}_{}", sc_instance, axis_index, direction),
                                display_name: format!("Joystick {} - {} {} (Axis {})", sc_instance, axis_name, direction_symbol, axis_index),
                                device_type: "Joystick".to_string(),
                                axis_value: Some(value),
                                modifiers: get_active_modifiers(),
                                is_modifier: false,
                                session_id: session_id.clone(),
                            }));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    Ok(None) // Timeout
}

/// Wait for multiple joystick inputs and collect them all
/// Continues listening for 2 seconds after the first input is detected
pub fn wait_for_multiple_inputs(session_id: String, initial_timeout_secs: u64, collect_duration_secs: u64) -> Result<Vec<DetectedInput>, String> {

    let mut gilrs = Gilrs::new().map_err(|e| e.to_string())?;
    
    // Track axis states to prevent duplicate triggers
    let mut axis_states: HashMap<(usize, u32), AxisState> = HashMap::new();
    
    // Pre-initialize all axes to their current state to prevent false triggers on startup
    for (_id, gamepad) in gilrs.gamepads() {
        let joystick_id = usize::from(gamepad.id());
        
        // Initialize all known axes
        for axis_idx in 1..=6 {
            let axis = match axis_idx {
                1 => Some(Axis::LeftStickX),
                2 => Some(Axis::LeftStickY),
                3 => Some(Axis::RightStickX),
                4 => Some(Axis::RightStickY),
                5 => Some(Axis::LeftZ),
                6 => Some(Axis::RightZ),
                _ => None,
            };
            
            if let Some(axis) = axis {
                let value = gamepad.axis_data(axis).map(|a| a.value()).unwrap_or(0.0);
                axis_states.insert(
                    (joystick_id, axis_idx),
                    AxisState {
                        last_value: value,
                        last_triggered_direction: None,
                    },
                );
            }
        }
    }
    
    let start = Instant::now();
    let initial_timeout = Duration::from_secs(initial_timeout_secs);
    let mut collected_inputs: Vec<DetectedInput> = Vec::new();
    let mut first_input_time: Option<Instant> = None;
    let collect_duration = Duration::from_secs(collect_duration_secs);
    
    // Axis detection thresholds
    const AXIS_TRIGGER_THRESHOLD: f32 = 0.5;
    const AXIS_RESET_THRESHOLD: f32 = 0.3;

    loop {
        // Check timeout conditions
        if first_input_time.is_none() {
            // Still waiting for first input
            if start.elapsed() >= initial_timeout {
                break; // Timeout reached, return what we have (might be empty)
            }
        } else {
            // First input detected, collect for additional duration
            if first_input_time.unwrap().elapsed() >= collect_duration {
                break; // Collection period complete
            }
        }
        
        while let Some(event) = gilrs.next_event_blocking(Some(Duration::from_millis(50))) {
            let detected_input = match event.event {
                EventType::ButtonPressed(button, code) => {
                    let joystick_id: usize = event.id.into();
                    let sc_instance = joystick_id + 1;
                    
                    let (input_string, display_name) = match button {
                        Button::DPadUp => (
                            format!("js{}_hat1_up", sc_instance),
                            format!("Joystick {} - Hat 1 UP", sc_instance)
                        ),
                        Button::DPadDown => (
                            format!("js{}_hat1_down", sc_instance),
                            format!("Joystick {} - Hat 1 DOWN", sc_instance)
                        ),
                        Button::DPadLeft => (
                            format!("js{}_hat1_left", sc_instance),
                            format!("Joystick {} - Hat 1 LEFT", sc_instance)
                        ),
                        Button::DPadRight => (
                            format!("js{}_hat1_right", sc_instance),
                            format!("Joystick {} - Hat 1 RIGHT", sc_instance)
                        ),
                        _ => {
                            let code_str = format!("{:?}", code);
                            let button_index = if let Some(start) = code_str.find("index: ") {
                                let rest = &code_str[start + 7..];
                                if let Some(end) = rest.find(' ') {
                                    rest[..end].parse::<u32>().unwrap_or(0) + 1
                                } else {
                                    0
                                }
                            } else {
                                0
                            };
                            
                            if button_index > 0 {
                                (
                                    format!("js{}_button{}", sc_instance, button_index),
                                    format!("Joystick {} - Button {}", sc_instance, button_index)
                                )
                            } else {
                                (
                                    format!("js{}_button_unknown", sc_instance),
                                    format!("Joystick {} - Button Unknown", sc_instance)
                                )
                            }
                        }
                    };
                    
                    Some(DetectedInput {
                        input_string,
                        display_name,
                        device_type: "Joystick".to_string(),
                        axis_value: None,
                        modifiers: get_active_modifiers(),
                        is_modifier: false,
                        session_id: session_id.clone(),
                    })
                }
                EventType::AxisChanged(axis, value, code) => {
                    let joystick_id: usize = event.id.into();
                    let sc_instance = joystick_id + 1;
                    
                    let code_str = format!("{:?}", code);
                    let axis_index = if let Some(start) = code_str.find("index: ") {
                        let rest = &code_str[start + 7..];
                        if let Some(end) = rest.find(' ') {
                            rest[..end].parse::<u32>().unwrap_or(0) + 1
                        } else {
                            0
                        }
                    } else {
                        0
                    };
                    
                    if axis_index > 0 {
                        let axis_key = (joystick_id, axis_index);
                        let state = axis_states.entry(axis_key).or_insert(AxisState {
                            last_value: value,
                            last_triggered_direction: None,
                        });
                        
                        let movement_delta = (value - state.last_value).abs();
                        const MOVEMENT_THRESHOLD: f32 = 0.3;
                        
                        let is_positive = value > AXIS_TRIGGER_THRESHOLD;
                        let is_negative = value < -AXIS_TRIGGER_THRESHOLD;
                        let is_centered = value.abs() < AXIS_RESET_THRESHOLD;
                        let has_moved_enough = movement_delta > MOVEMENT_THRESHOLD;
                        
                        if is_centered {
                            state.last_triggered_direction = None;
                            state.last_value = value;
                        }
                        
                        let should_trigger_positive = is_positive && has_moved_enough && state.last_triggered_direction != Some(true);
                        let should_trigger_negative = is_negative && has_moved_enough && state.last_triggered_direction != Some(false);
                        
                        if should_trigger_positive || should_trigger_negative {
                            let direction = if should_trigger_positive { "positive" } else { "negative" };
                            let direction_symbol = if should_trigger_positive { "+" } else { "-" };
                            
                            state.last_triggered_direction = Some(should_trigger_positive);
                            state.last_value = value;
                            
                            let axis_name = match axis {
                                Axis::LeftStickX => "Left Stick X",
                                Axis::LeftStickY => "Left Stick Y",
                                Axis::RightStickX => "Right Stick X",
                                Axis::RightStickY => "Right Stick Y",
                                Axis::LeftZ => "Left Z",
                                Axis::RightZ => "Right Z",
                                _ => "Axis",
                            };
                            
                            Some(DetectedInput {
                                input_string: format!("js{}_axis{}_{}", sc_instance, axis_index, direction),
                                display_name: format!("Joystick {} - {} {} (Axis {})", sc_instance, axis_name, direction_symbol, axis_index),
                                device_type: "Joystick".to_string(),
                                axis_value: Some(value),
                                modifiers: get_active_modifiers(),
                                is_modifier: false,
                                session_id: session_id.clone(),
                            })
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };
            
            if let Some(input) = detected_input {
                // Check if this input is already in the list (avoid duplicates)
                if !collected_inputs.iter().any(|i| i.input_string == input.input_string) {
                    collected_inputs.push(input);
                    
                    // Mark the time when first input was detected
                    if first_input_time.is_none() {
                        first_input_time = Some(Instant::now());
                    }
                }
            }
        }
    }

    Ok(collected_inputs)
}

/// Wait for joystick inputs and emit events in real-time as they're detected
/// This version uses Tauri's event system to send updates to the frontend immediately
pub fn wait_for_inputs_with_events(window: tauri::Window, session_id: String, initial_timeout_secs: u64, collect_duration_secs: u64) -> Result<(), String> {
    use std::collections::HashMap;

    let mut gilrs = Gilrs::new().map_err(|e| e.to_string())?;
    
    // Track axis states to prevent duplicate triggers
    let mut axis_states: HashMap<(usize, u32), AxisState> = HashMap::new();
    
    // Pre-initialize all axes to their current state
    for (_id, gamepad) in gilrs.gamepads() {
        let joystick_id = usize::from(gamepad.id());
        
        for axis_idx in 1..=6 {
            let axis = match axis_idx {
                1 => Some(Axis::LeftStickX),
                2 => Some(Axis::LeftStickY),
                3 => Some(Axis::RightStickX),
                4 => Some(Axis::RightStickY),
                5 => Some(Axis::LeftZ),
                6 => Some(Axis::RightZ),
                _ => None,
            };
            
            if let Some(axis) = axis {
                let value = gamepad.axis_data(axis).map(|a| a.value()).unwrap_or(0.0);
                axis_states.insert(
                    (joystick_id, axis_idx),
                    AxisState {
                        last_value: value,
                        last_triggered_direction: None,
                    },
                );
            }
        }
    }
    
    let start = Instant::now();
    let initial_timeout = Duration::from_secs(initial_timeout_secs);
    let mut detected_inputs: std::collections::HashSet<String> = std::collections::HashSet::new(); // Track to avoid duplicates
    let mut first_input_time: Option<Instant> = None;
    let collect_duration = Duration::from_secs(collect_duration_secs);
    
    const AXIS_TRIGGER_THRESHOLD: f32 = 0.5;
    const AXIS_RESET_THRESHOLD: f32 = 0.3;

    loop {
        // Check timeout conditions
        if first_input_time.is_none() {
            if start.elapsed() >= initial_timeout {
                // Emit completion event
                let _ = window.emit("input-detection-complete", DetectionComplete { session_id: session_id.clone() });
                break;
            }
        } else {
            if first_input_time.unwrap().elapsed() >= collect_duration {
                // Emit completion event
                let _ = window.emit("input-detection-complete", DetectionComplete { session_id: session_id.clone() });
                break;
            }
        }
        
        while let Some(event) = gilrs.next_event_blocking(Some(Duration::from_millis(50))) {
            let detected_input = match event.event {
                EventType::ButtonPressed(button, code) => {
                    let joystick_id: usize = event.id.into();
                    let sc_instance = joystick_id + 1;
                    
                    let (input_string, display_name) = match button {
                        Button::DPadUp => (
                            format!("js{}_hat1_up", sc_instance),
                            format!("Joystick {} - Hat 1 UP", sc_instance)
                        ),
                        Button::DPadDown => (
                            format!("js{}_hat1_down", sc_instance),
                            format!("Joystick {} - Hat 1 DOWN", sc_instance)
                        ),
                        Button::DPadLeft => (
                            format!("js{}_hat1_left", sc_instance),
                            format!("Joystick {} - Hat 1 LEFT", sc_instance)
                        ),
                        Button::DPadRight => (
                            format!("js{}_hat1_right", sc_instance),
                            format!("Joystick {} - Hat 1 RIGHT", sc_instance)
                        ),
                        _ => {
                            let code_str = format!("{:?}", code);
                            let button_index = if let Some(start) = code_str.find("index: ") {
                                let rest = &code_str[start + 7..];
                                if let Some(end) = rest.find(' ') {
                                    rest[..end].parse::<u32>().unwrap_or(0) + 1
                                } else {
                                    0
                                }
                            } else {
                                0
                            };
                            
                            if button_index > 0 {
                                (
                                    format!("js{}_button{}", sc_instance, button_index),
                                    format!("Joystick {} - Button {}", sc_instance, button_index)
                                )
                            } else {
                                continue;
                            }
                        }
                    };
                    
                    Some(DetectedInput {
                        input_string,
                        display_name,
                        device_type: "Joystick".to_string(),
                        axis_value: None,
                        modifiers: get_active_modifiers(),
                        is_modifier: false,
                        session_id: session_id.clone(),
                    })
                }
                EventType::AxisChanged(axis, value, code) => {
                    let joystick_id: usize = event.id.into();
                    let sc_instance = joystick_id + 1;
                    
                    let axis_index = match axis {
                        Axis::LeftStickX => 1,
                        Axis::LeftStickY => 2,
                        Axis::RightStickX => 3,
                        Axis::RightStickY => 4,
                        Axis::LeftZ => 5,
                        Axis::RightZ => 6,
                        _ => 0,
                    };
                    
                    if axis_index > 0 {
                        let axis_key = (joystick_id, axis_index);
                        let state = axis_states.entry(axis_key).or_insert(AxisState {
                            last_value: 0.0,
                            last_triggered_direction: None,
                        });
                        
                        let abs_value = value.abs();
                        let is_positive = value > 0.0;
                        let should_trigger = match state.last_triggered_direction {
                            None => abs_value >= AXIS_TRIGGER_THRESHOLD,
                            Some(last_positive) if last_positive == is_positive => false,
                            Some(_) => {
                                if abs_value >= AXIS_TRIGGER_THRESHOLD {
                                    true
                                } else {
                                    false
                                }
                            }
                        };
                        
                        if abs_value < AXIS_RESET_THRESHOLD {
                            state.last_triggered_direction = None;
                        }
                        
                        state.last_value = value;
                        
                        if should_trigger {
                            state.last_triggered_direction = Some(is_positive);
                            
                            let direction = if is_positive { "positive" } else { "negative" };
                            let direction_symbol = if is_positive { "+" } else { "-" };
                            
                            let axis_name = match axis {
                                Axis::LeftStickX => "X",
                                Axis::LeftStickY => "Y",
                                Axis::RightStickX => "RX",
                                Axis::RightStickY => "RY",
                                Axis::LeftZ => "Z",
                                Axis::RightZ => "RZ",
                                _ => "Unknown",
                            };
                            
                            let direction_symbol = if direction == "positive" { "+" } else { "-" };
                            
                            Some(DetectedInput {
                                input_string: format!("js{}_axis{}_{}", sc_instance, axis_index, direction),
                                display_name: format!("Joystick {} - {} {} (Axis {})", sc_instance, axis_name, direction_symbol, axis_index),
                                device_type: "Joystick".to_string(),
                                axis_value: Some(value),
                                modifiers: get_active_modifiers(),
                                is_modifier: false,
                                session_id: session_id.clone(),
                            })
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };
            
            if let Some(input) = detected_input {
                // Check if this input is already detected (avoid duplicates)
                if !detected_inputs.contains(&input.input_string) {
                    detected_inputs.insert(input.input_string.clone());
                    
                    // Emit event immediately
                    let _ = window.emit("input-detected", &input);
                    
                    // Mark the time when first input was detected
                    if first_input_time.is_none() {
                        first_input_time = Some(Instant::now());
                    }
                }
            }
        }
    }

    Ok(())
}

/// Get list of available joysticks
pub fn detect_joysticks() -> Result<Vec<JoystickInfo>, String> {
    let gilrs = Gilrs::new().map_err(|e| e.to_string())?;
    
    let mut joysticks = Vec::new();
    
    for (_id, gamepad) in gilrs.gamepads() {
        joysticks.push(JoystickInfo {
            id: usize::from(gamepad.id()),
            name: gamepad.name().to_string(),
            is_connected: gamepad.is_connected(),
            button_count: 32, // gilrs doesn't provide exact count, estimate
            axis_count: 8,     // gilrs doesn't provide exact count, estimate
            hat_count: 1,      // Most devices have at least 1 hat
        });
    }
    
    Ok(joysticks)
}
