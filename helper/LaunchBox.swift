// LaunchBox — the approval helper. Layer 2 of docs/specs/2026-07-26-local-api-auth-design.md.
//
// Compiled at install time by lib/install.js into ~/.claude-scheduler/bin/LaunchBox:
//
//     swiftc -O -o ~/.claude-scheduler/bin/LaunchBox helper/LaunchBox.swift
//
// MEASURED FACTS — verified by spike on 2026-07-26 from a background launchd agent.
// These are not stylistic choices; changing any of them changes what the user sees or
// breaks the binary outright.
//
//  1. THE FILENAME IS THE DIALOG TITLE. macOS titles the authentication sheet with the
//     executable's filename, not with a bundle name, an argv[0] override, or anything this
//     source can set. The output MUST be named exactly `LaunchBox` — rename the binary and
//     you rename the dialog, which is the one piece of provenance the user has to decide
//     whether to press their finger down.
//
//  2. THE REASON STRING IS APPENDED, NOT SHOWN ALONE. The sheet reads
//     "<filename> is trying to <reason>." — i.e. "LaunchBox is trying to create the
//     scheduled job “nightly sweep”, which can run commands on this Mac." So `reason` must
//     be a sentence *completion*: lowercase, no leading subject, no trailing period, and it
//     should name the object it is about. A reason phrased as its own sentence reads as
//     broken English inside the system sheet.
//
//  3. NEVER POST-PROCESS THIS BINARY. `swiftc` emits a mandatory adhoc code signature on
//     Apple Silicon. Stripping or re-signing it (`strip`, `codesign --remove-signature`)
//     makes the kernel SIGKILL the process — the caller sees exit 137 and no stdout at all.
//     Install treats 137 as tamper/corruption rather than as a refusal.
//
//  4. THE WAIT BOUND IS 180s. An earlier build used 120s; a real password approval measured
//     67.6s against that bound, which is far too little headroom once the user has to find
//     the keyboard, so it is 180s here. It is still bounded: a background agent must never
//     hang forever on a dialog nobody is looking at.
//
// Two modes on purpose:
//   --check          canEvaluatePolicy only. NEVER prompts, so it is safe to run in every
//                    context — install verification, health checks, tests — and answers "is
//                    an approval reachable from here at all" without needing a finger.
//   --auth <reason>  the real evaluatePolicy prompt.
//
// Policy is .deviceOwnerAuthentication (biometry OR password) rather than
// ...WithBiometrics: a wet finger or a Mac with no Touch ID must fall back to the login
// password, not lock the user out of their own scheduler.
//
// Contract with the caller (lib/approval.js):
//   stdout is exactly one line of JSON, always, in every mode including failure.
//   exit 0   = approved (or, for --check, "an approval is reachable")
//   exit 1   = refused / unavailable — read `errorCode`; -2 is LAError.userCancel,
//              i.e. the user actively denied, as opposed to a system-level failure
//   exit 2   = bad usage
//   exit 137 = SIGKILL, tampered or unsigned binary (see fact 3); no stdout

import Foundation
import LocalAuthentication

let args = Array(CommandLine.arguments.dropFirst())
let policy: LAPolicy = .deviceOwnerAuthentication

// Bounded wait for the approval sheet. See fact 4.
let authTimeoutSeconds = 180

func emit(_ dict: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

// Reported so the caller can tell "no hardware" from "not reachable from this context".
func biometryName(_ t: LABiometryType) -> String {
    switch t {
    case .none: return "none"
    case .touchID: return "touchID"
    case .faceID: return "faceID"
    default: return "other(\(t.rawValue))"
    }
}

let ctx = LAContext()
// The sheet's secondary button. "Deny" rather than the default "Cancel": the user is
// answering a request, and cancelling sounds like backing out of their own action.
ctx.localizedCancelTitle = "Deny"

switch args.first {
case "--check":
    var err: NSError?
    let ok = ctx.canEvaluatePolicy(policy, error: &err)
    emit([
        "mode": "check",
        "canEvaluate": ok,
        "biometryType": biometryName(ctx.biometryType),
        "errorCode": err?.code ?? 0,
        "error": err?.localizedDescription ?? "",
        "hasTTY": isatty(STDIN_FILENO) == 1,
        "sessionHasGUI": ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] ?? "(unset)",
    ])
    exit(ok ? 0 : 1)

case "--auth":
    // Must complete the sentence "LaunchBox is trying to …" — see fact 2.
    let reason = args.count > 1 ? args[1] : "approve this action"
    let sem = DispatchSemaphore(value: 0)
    var success = false
    var errMsg = ""
    var errCode = 0
    let start = Date()
    ctx.evaluatePolicy(policy, localizedReason: reason) { ok, error in
        success = ok
        if let e = error as NSError? {
            errMsg = e.localizedDescription
            errCode = e.code
        }
        sem.signal()
    }
    let timedOut = sem.wait(timeout: .now() + .seconds(authTimeoutSeconds)) == .timedOut
    emit([
        "mode": "auth",
        "success": success,
        "timedOut": timedOut,
        "elapsedMs": Int(Date().timeIntervalSince(start) * 1000),
        "errorCode": errCode,
        "error": errMsg,
        "hasTTY": isatty(STDIN_FILENO) == 1,
    ])
    exit(success ? 0 : 1)

default:
    emit(["error": "usage: LaunchBox --check | --auth <reason>"])
    exit(2)
}
