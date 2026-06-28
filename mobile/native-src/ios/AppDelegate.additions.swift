// =====================================================================
// AppDelegate additions for NativeBgUpload — MERGE these into the generated
// mobile/ios/App/App/AppDelegate.swift after `npx cap add ios`.
// (This file is NOT compiled as-is; it's a copy-paste guide.)
// =====================================================================

import BackgroundTasks   // add to the imports at the top of AppDelegate.swift

// --- 1. In application(_:didFinishLaunchingWithOptions:), BEFORE `return true`,
//        register the background task handler AND activate the background URLSession
//        (so its delegate is ready to receive completion events from transfers that
//        finished while the app was suspended). Registration must happen during
//        launch or iOS throws. ---
//
//        BGTaskScheduler.shared.register(
//            forTaskWithIdentifier: BgUploader.taskIdentifier,
//            using: nil
//        ) { task in
//            BgUploader.shared.handleProcessingTask(task as! BGProcessingTask)
//        }
//        BgUploader.shared.activate()

// --- 1b. PHASE 3: handle background URLSession completion events. iOS relaunches
//        the app (sessionSendsLaunchEvents) when background transfers finish; it
//        passes a completion handler we must store and call once the session has
//        delivered all its events. Add this method to the AppDelegate class: ---
//
//    func application(_ application: UIApplication,
//                     handleEventsForBackgroundURLSession identifier: String,
//                     completionHandler: @escaping () -> Void) {
//        if identifier == BgUploader.sessionIdentifier {
//            BgUploader.shared.backgroundCompletionHandler = completionHandler
//            BgUploader.shared.activate()   // ensure the delegate is wired
//        } else {
//            completionHandler()
//        }
//    }

// --- 2. On entering the background, enqueue any pending work onto the background
//        session and re-arm the BGProcessingTask. The background-session tasks run
//        on their own (they survive suspension/termination), so we DON'T need to
//        hold a background-task assertion open for them. Add to the AppDelegate: ---
//
//    func applicationDidEnterBackground(_ application: UIApplication) {
//        BgUploader.shared.scheduleProcessing()
//        BgUploader.shared.drain()
//    }
//
// --- 3. (Optional) also kick a drain on becoming active, belt-and-suspenders in
//        addition to the web reconcile loop: ---
//
//    func applicationDidBecomeActive(_ application: UIApplication) {
//        BgUploader.shared.drain()
//    }
