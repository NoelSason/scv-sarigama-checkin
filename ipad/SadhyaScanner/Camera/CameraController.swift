import AVFoundation
import SwiftUI

/// A QR code currently visible, with where it sits on screen.
///
/// The rect is in preview-layer coordinates, not camera coordinates — the whole
/// point of tracking it is to draw something on top of the code the volunteer is
/// looking at.
struct Sighting: Identifiable, Equatable {
    let id: String
    var rect: CGRect
}

/// Owns the capture session and turns metadata into things on screen.
///
/// AVCaptureMetadataOutput rather than Vision or DataScanner: it decodes on the
/// capture pipeline's own thread, costs almost nothing, and hands back a rect
/// per code. A door scanner needs exactly that and nothing else.
final class CameraController: NSObject, ObservableObject {
    enum Access {
        case unknown, granted, denied, unavailable
    }

    @Published private(set) var access: Access = .unknown
    @Published private(set) var isRunning = false
    /// Every code in frame right now. Usually one; occasionally two when a
    /// family holds up two phones at once, which is why it is a list.
    @Published private(set) var sightings: [Sighting] = []

    /// Suspends reporting while a panel is up. The camera keeps running
    /// underneath — stopping and restarting it costs half a second of black
    /// screen — but a code left in frame can no longer re-trigger anything.
    var paused = false {
        didSet {
            guard paused != oldValue else { return }
            if paused { sightings = [] }
        }
    }

    /// Fired once per accepted code, on the main thread.
    var onScan: ((String) -> Void)?

    let session = AVCaptureSession()
    weak var previewLayer: AVCaptureVideoPreviewLayer?

    private let output = AVCaptureMetadataOutput()
    private let sessionQueue = DispatchQueue(label: "com.scvsarigama.sadhya.session")
    private var configured = false
    private var lastFired = Date.distantPast

    /// How long the same code is ignored after being read.
    ///
    /// Long enough that a guest lowering their phone slowly cannot double-fire,
    /// short enough that a volunteer who cancels out of a panel can immediately
    /// rescan the same pass.
    private let cooldown: TimeInterval = 1.6

    // MARK: - Lifecycle

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            access = .granted
            configureAndRun()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.access = granted ? .granted : .denied
                    if granted { self.configureAndRun() }
                }
            }
        default:
            access = .denied
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
            DispatchQueue.main.async { self.isRunning = false }
        }
    }

    private func configureAndRun() {
        sessionQueue.async { [weak self] in
            guard let self else { return }

            if !self.configured {
                guard self.configure() else {
                    DispatchQueue.main.async { self.access = .unavailable }
                    return
                }
                self.configured = true
            }

            if !self.session.isRunning { self.session.startRunning() }
            DispatchQueue.main.async { self.isRunning = self.session.isRunning }
        }
    }

    private func configure() -> Bool {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        // .high rather than .photo: the frames are only ever decoded, never
        // shown at full resolution or saved, and a smaller buffer is a faster
        // decode.
        session.sessionPreset = .high

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else { return false }
        session.addInput(input)

        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        // Delivered on the main queue so rects can be converted through the
        // preview layer, which is UIKit and main-thread-only, without a hop.
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []

        // A pass is a phone screen held up close, and close is where fixed focus
        // fails. Continuous autofocus on the near range is the difference
        // between "instant" and "wave it around a bit".
        if (try? device.lockForConfiguration()) != nil {
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            if device.isAutoFocusRangeRestrictionSupported {
                device.autoFocusRangeRestriction = .near
            }
            device.unlockForConfiguration()
        }

        return true
    }

    // MARK: - Interaction

    /// Pick one code out of several in frame. Only reachable by tapping it.
    func choose(_ id: String) {
        fire(id)
    }

    /// Tap anywhere on the picture to focus there.
    ///
    /// Continuous autofocus hunts when half the frame is a bright phone screen
    /// and the other half is a crowded hall. Being able to say "that bit" is the
    /// fastest fix available to someone with a queue in front of them.
    func focus(atLayerPoint point: CGPoint) {
        guard
            let previewLayer,
            let device = (session.inputs.compactMap { $0 as? AVCaptureDeviceInput }.first)?.device
        else { return }

        let target = previewLayer.captureDevicePointConverted(fromLayerPoint: point)
        sessionQueue.async {
            guard (try? device.lockForConfiguration()) != nil else { return }
            if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) {
                device.focusPointOfInterest = target
                device.focusMode = .autoFocus
            }
            if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposurePointOfInterest = target
                device.exposureMode = .continuousAutoExposure
            }
            device.unlockForConfiguration()
        }
    }

    private func fire(_ payload: String) {
        guard !paused, Date().timeIntervalSince(lastFired) > cooldown else { return }
        lastFired = Date()
        Chime.shared.play(.ding)
        onScan?(payload)
    }
}

extension CameraController: AVCaptureMetadataOutputObjectsDelegate {
    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !paused else { return }

        var seen: [Sighting] = []
        for object in metadataObjects {
            guard
                let code = object as? AVMetadataMachineReadableCodeObject,
                let payload = code.stringValue,
                !payload.isEmpty
            else { continue }
            let rect = previewLayer?.transformedMetadataObject(for: code)?.bounds ?? .zero
            seen.append(Sighting(id: payload, rect: rect))
        }

        if seen != sightings { sightings = seen }

        // One code in frame is the whole event: scan it. Two or more and the
        // app refuses to guess — the volunteer taps the one they mean, because
        // choosing wrong here spends someone else's admissions.
        if seen.count == 1 { fire(seen[0].id) }
    }
}
