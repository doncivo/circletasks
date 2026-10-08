// swift-tools-version:5.3
// Plugin haptics de CircleTasks (ADR 0013 §1.1) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-ct-haptics",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-ct-haptics",
      type: .static,
      targets: ["tauri-plugin-ct-haptics"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ct-haptics",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
