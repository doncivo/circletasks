// swift-tools-version:5.3
// Plugin speech de CircleTasks (ADR 0015) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-speech",
  platforms: [
    .iOS("17.0")
  ],
  products: [
    .library(
      name: "tauri-plugin-speech",
      type: .static,
      targets: ["tauri-plugin-speech"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-speech",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
