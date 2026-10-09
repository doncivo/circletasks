// swift-tools-version:5.3
// Plugin reminders de CircleTasks (ADR 0008 §10.4) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-reminders",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-reminders",
      type: .static,
      targets: ["tauri-plugin-reminders"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-reminders",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
