// swift-tools-version:5.3
// Plugin notification-actions de CircleTasks (ADR 0012 avenant N-03) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-notification-actions",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-notification-actions",
      type: .static,
      targets: ["tauri-plugin-notification-actions"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-notification-actions",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
