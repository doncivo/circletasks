// swift-tools-version:5.3
// Plugin ct-files de CircleTasks (FILES-IOS-01, ADR 0009 avenant lot F) : compilé par build-ios.yml seulement (aucun Mac local).

import PackageDescription

let package = Package(
  name: "tauri-plugin-ct-files",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-ct-files",
      type: .static,
      targets: ["tauri-plugin-ct-files"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ct-files",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
