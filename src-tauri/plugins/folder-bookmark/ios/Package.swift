// swift-tools-version:5.3
// Plugin folder-bookmark de CircleTasks (ADR 0011 §22) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-folder-bookmark",
  platforms: [
    .iOS(.v15)
  ],
  products: [
    .library(
      name: "tauri-plugin-folder-bookmark",
      type: .static,
      targets: ["tauri-plugin-folder-bookmark"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-folder-bookmark",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
