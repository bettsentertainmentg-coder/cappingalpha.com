import UIKit
import Capacitor

/// The app's bridge view controller, which exists for exactly one reason:
/// **registering CANativePlugin**.
///
/// Capacitor only auto-registers plugins that arrive from npm packages, via the
/// list `npx cap sync` generates from package.json. A plugin written directly in
/// the app target is compiled into the binary but never reaches the bridge, so
/// `window.Capacitor.Plugins.CANative` is simply absent and every caller silently
/// falls back to its web path.
///
/// That is not a theoretical failure mode. On 2026-08-26 the whole betslip share
/// chain worked end to end on the simulator right up to this point: the extension
/// ran, Vision read the slip, the App Group carried it, the deep link opened the
/// app, and then nothing happened, because `Capacitor.Plugins` listed 16 plugins
/// and none of them was ours.
///
/// If a future `npx cap sync ios` ever rewrites Main.storyboard back to plain
/// `CAPBridgeViewController`, the share hand-off dies silently. `scripts/add_share_extension.rb`
/// re-points the storyboard at this class and is safe to re-run.
class MainViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(CANativePlugin())
    }
}
