// swift-tools-version:5.3
// Plugin vision de CircleTasks (ADR 0015) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-vision",
  platforms: [
    .iOS("17.0")
  ],
  products: [
    .library(
      name: "tauri-plugin-vision",
      type: .static,
      targets: ["tauri-plugin-vision"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-vision",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
