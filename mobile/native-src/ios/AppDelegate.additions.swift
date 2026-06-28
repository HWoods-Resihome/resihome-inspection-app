// =====================================================================
// AppDelegate additions for NativeBgUpload — MERGE these into the generated
// mobile/ios/App/App/AppDelegate.swift after `npx cap add ios`.
// (This file is NOT compiled as-is; it's a copy-paste guide.)
// =====================================================================

import BackgroundTasks   // add to the imports at the top of AppDelegate.swift

// --- 1. In application(_:didFinishLaunchingWithOptions:), BEFORE `return true`,
//        register the background task handler. Registration must happen during
//        launch or iOS throws. ---
//
//        BGTaskScheduler.shared.register(
//            forTaskWithIdentifier: BgUploader.taskIdentifier,
//            using: nil
//        ) { task in
//            BgUploader.shared.handleProcessingTask(task as! BGProcessingTask)
//        }

// --- 2. Drain (and re-arm) when the app goes to the background, so work started
//        in-session continues into the OS-granted window. Add this method to the
//        AppDelegate class: ---
//
//    func applicationDidEnterBackground(_ application: UIApplication) {
//        // Hold a short background-task assertion so an in-flight drain isn't
//        // suspended the instant we background; also schedule the BGProcessingTask
//        // for the force-quit / later case.
//        var bgTask: UIBackgroundTaskIdentifier = .invalid
//        bgTask = application.beginBackgroundTask(withName: "resiwalk-bgupload-drain") {
//            application.endBackgroundTask(bgTask); bgTask = .invalid
//        }
//        BgUploader.shared.scheduleProcessing()
//        Task {
//            await BgUploader.shared.drainAsync()
//            if bgTask != .invalid { application.endBackgroundTask(bgTask); bgTask = .invalid }
//        }
//    }
//
// --- 3. (Optional) also kick a drain on becoming active, as a belt-and-suspenders
//        in addition to the web reconcile loop: ---
//
//    func applicationDidBecomeActive(_ application: UIApplication) {
//        BgUploader.shared.drain()
//    }
