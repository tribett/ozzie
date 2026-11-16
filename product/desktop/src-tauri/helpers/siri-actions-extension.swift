// The entry point of Ozzie's Siri actions extension (siri-actions.swift, ADR 0007). The system starts it when Siri,
// Spotlight or Shortcuts runs one of Ozzie's actions; it has nothing of its own to configure.
import AppIntents
import ExtensionFoundation

@main
struct OzzieIntentsExtension: AppIntentsExtension {}
