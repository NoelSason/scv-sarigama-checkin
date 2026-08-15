import AVFoundation
import SwiftUI

/// The live camera, filling whatever it is given.
struct CameraSurface: UIViewRepresentable {
    let controller: CameraController

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = controller.session
        view.previewLayer.videoGravity = .resizeAspectFill
        controller.previewLayer = view.previewLayer
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        // Safe by construction: layerClass above guarantees the type.
        layer as! AVCaptureVideoPreviewLayer
    }

    /// Keep the preview upright as the tablet turns.
    ///
    /// Rotation is applied here rather than at configuration time because a
    /// scanner on a stand gets picked up and turned around constantly, and a
    /// sideways preview is not merely ugly — a volunteer aiming at a code they
    /// see rotated aims wrong.
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let connection = previewLayer.connection else { return }

        let angle: CGFloat
        switch window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: angle = 180
        case .landscapeRight: angle = 0
        case .portraitUpsideDown: angle = 270
        default: angle = 90
        }

        if connection.isVideoRotationAngleSupported(angle), connection.videoRotationAngle != angle {
            connection.videoRotationAngle = angle
        }
    }
}
