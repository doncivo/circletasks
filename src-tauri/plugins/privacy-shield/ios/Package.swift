// swift-tools-version:5.3
// Plugin privacy-shield de CircleTasks (ADR 0013 §2.5) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-privacy-shield",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-privacy-shield",
      type: .static,
      targets: ["tauri-plugin-privacy-shield"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-privacy-shield",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
