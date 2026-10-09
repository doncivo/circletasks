// swift-tools-version:5.3
// Plugin web-auth de CircleTasks (ADR 0008 §9.1) : compilé par build-ios.yml seulement (aucun Mac local).
// Plateforme .iOS(.v14) : la plus récente que swift-tools-version 5.3 connaisse (comme folder-bookmark) ; ASWebAuthenticationSession
// et prefersEphemeralWebBrowserSession existent depuis iOS 13 ; l'app exige iOS 18.

import PackageDescription

let package = Package(
  name: "tauri-plugin-web-auth",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-web-auth",
      type: .static,
      targets: ["tauri-plugin-web-auth"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-web-auth",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
