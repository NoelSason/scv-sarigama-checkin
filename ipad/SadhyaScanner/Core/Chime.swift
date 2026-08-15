import AVFoundation

/// Every sound the app makes, synthesised at launch.
///
/// No audio files ship with the app. A bell is four decaying sine partials and
/// twenty lines of arithmetic, and generating it means the tones can be tuned by
/// changing a number rather than by finding, licensing, and trimming a sample.
/// It also keeps the bundle honest: nothing to lose, nothing to mis-encode.
///
/// Each tone owns its own player node so that a scan chime and the result tone
/// that follows it a moment later can overlap instead of queueing — a single
/// node plays scheduled buffers back to back, which at a fast line turns into an
/// audible lag between the code being read and the sound arriving.
final class Chime {
    enum Tone: CaseIterable {
        /// A code was read. Fires the instant the camera resolves it, before
        /// any network call — this is the sound a volunteer listens for.
        case ding
        /// Admissions were released. Deliberately warmer and longer than the
        /// ding, so the two are never confused across a noisy hall.
        case admitted
        /// Refused, not admitted. Low and blunt; nothing about it sounds like
        /// a success heard from a distance.
        case refused
        /// Surface feedback — a tile pressed, a code picked out of the frame.
        case tap
    }

    static let shared = Chime()

    private let engine = AVAudioEngine()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
    private var players: [Tone: AVAudioPlayerNode] = [:]
    private var buffers: [Tone: AVAudioPCMBuffer] = [:]
    private var running = false

    private init() {
        for tone in Tone.allCases {
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            players[tone] = player
            buffers[tone] = render(tone)
        }
    }

    /// Called once, at launch. Starting the engine lazily on the first scan
    /// costs tens of milliseconds — exactly where it would be heard.
    func warmUp() {
        guard !running else { return }
        do {
            // .playback, mixed: the scanner should still be audible with the
            // tablet's ringer switch set to silent, without silencing whatever
            // is playing over the hall speakers.
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            try engine.start()
            for player in players.values { player.play() }
            running = true
        } catch {
            // A scanner with no sound is a degraded scanner, not a broken one.
            // The screen carries the same information.
            running = false
        }
    }

    func play(_ tone: Tone) {
        guard running, let player = players[tone], let buffer = buffers[tone] else { return }
        if !player.isPlaying { player.play() }
        // .interrupts so a second scan restarts the chime instead of waiting
        // behind the first one.
        player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
    }

    // MARK: - Synthesis

    private func render(_ tone: Tone) -> AVAudioPCMBuffer {
        switch tone {
        case .ding:
            // A struck bell: a bright fundamental with inharmonic partials above
            // it, decaying fast. High enough to cut through crowd noise, short
            // enough to fire twice in a second without smearing.
            return render(seconds: 1.1) { t in
                bell(t, partials: [(1568, 1.0), (3136, 0.42), (4327, 0.22), (6272, 0.09)], decay: 0.26)
            }

        case .admitted:
            // The same bell twice, a fifth apart, the second entering while the
            // first is still ringing. Reads as "done" rather than "read".
            return render(seconds: 1.6) { t in
                let first = bell(t, partials: [(1046.5, 1.0), (2093, 0.35), (2888, 0.16)], decay: 0.34)
                let second = bell(t - 0.11, partials: [(1568, 1.0), (3136, 0.35), (4327, 0.16)], decay: 0.42)
                return (first + second) * 0.62
            }

        case .refused:
            // Two low thuds. No partials above the second harmonic, so it stays
            // under the ding rather than competing with it.
            return render(seconds: 0.7) { t in
                let a = bell(t, partials: [(196, 1.0), (98, 0.7)], decay: 0.10)
                let b = bell(t - 0.17, partials: [(165, 1.0), (82.5, 0.7)], decay: 0.13)
                return (a + b) * 0.85
            }

        case .tap:
            // A click, not a note: quiet enough to press a hundred times.
            return render(seconds: 0.09) { t in
                bell(t, partials: [(2200, 1.0), (3300, 0.3)], decay: 0.014) * 0.35
            }
        }
    }

    /// Sum of exponentially decaying sines with a short attack ramp.
    ///
    /// The ramp matters: a sine that starts at full amplitude begins with a step
    /// discontinuity, and a step is a click. Four milliseconds is inaudible as a
    /// fade and removes it entirely.
    private func bell(_ t: Double, partials: [(freq: Double, amp: Double)], decay: Double) -> Float {
        guard t >= 0 else { return 0 }
        let envelope = exp(-t / decay) * min(1, t / 0.004)
        var value = 0.0
        for partial in partials {
            value += partial.amp * sin(2 * .pi * partial.freq * t)
        }
        let normalise = partials.reduce(0) { $0 + $1.amp }
        return Float(value / normalise * envelope * 0.5)
    }

    private func render(seconds: Double, _ sample: (Double) -> Float) -> AVAudioPCMBuffer {
        let frames = AVAudioFrameCount(seconds * format.sampleRate)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        guard let channels = buffer.floatChannelData else { return buffer }

        for frame in 0..<Int(frames) {
            // Clamped rather than scaled: the tones are written well under full
            // scale, so this only ever catches an edit that overshoots.
            let value = max(-1, min(1, sample(Double(frame) / format.sampleRate)))
            for channel in 0..<Int(format.channelCount) {
                channels[channel][frame] = value
            }
        }
        return buffer
    }
}
