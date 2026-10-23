//! macOS: the capture panel as a non-activating panel, like Spotlight's. It takes the keyboard
//! while the app in front stays active, so Vasta (and its main window) does not come forward.

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{sel, ClassType};
use objc2_app_kit::{NSPanel, NSWindowCollectionBehavior, NSWindowStyleMask};
use tauri::WebviewWindow;

/// An NSPanel that takes the keyboard although it has no title bar. It has the one ivar of tao's
/// TaoWindow, and NSPanel none of its own, so a window made by tao can become one.
fn class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        extern "C-unwind" fn yes(_: &AnyObject, _: Sel) -> Bool {
            Bool::YES
        }
        extern "C-unwind" fn no(_: &AnyObject, _: Sel) -> Bool {
            Bool::NO
        }
        let mut builder = ClassBuilder::new(c"VastaCapturePanel", NSPanel::class()).expect("one panel class");
        builder.add_ivar::<Bool>(c"focusable");
        unsafe {
            builder.add_method(sel!(canBecomeKeyWindow), yes as extern "C-unwind" fn(_, _) -> _);
            builder.add_method(sel!(canBecomeMainWindow), no as extern "C-unwind" fn(_, _) -> _);
        }
        builder.register()
    })
}

/// Run `f` with the window's NSPanel, on the main thread (AppKit's only one).
fn with_panel(window: &WebviewWindow, f: impl FnOnce(&NSPanel) + Send + 'static) {
    let Ok(pointer) = window.ns_window() else { return };
    let pointer = pointer as usize;
    let _ = window.run_on_main_thread(move || {
        if let Some(panel) = unsafe { (pointer as *const NSPanel).as_ref() } {
            f(panel)
        }
    });
}

/// Turn the capture window into the panel; once, right after it is made.
pub fn make(window: &WebviewWindow) {
    with_panel(window, |panel| {
        unsafe { AnyObject::set_class(panel.as_ref(), class()) };
        panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        panel.setFloatingPanel(true);
        panel.setHidesOnDeactivate(false);
        panel.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
    });
}

/// Bring the panel up over the app in front and give it the keyboard, without activating Vasta.
pub fn show(window: &WebviewWindow) {
    with_panel(window, |panel| {
        panel.orderFrontRegardless();
        panel.makeKeyWindow();
    });
}
