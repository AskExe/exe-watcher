// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ExeWatcherMenubar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ExeWatcherMenubar", targets: ["ExeWatcherMenubar"])
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")
    ],
    targets: [
        .executableTarget(
            name: "ExeWatcherMenubar",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/ExeWatcherMenubar",
            resources: [
                .copy("Resources/owl.pdf"),
                .copy("Resources/owl-menubar.pdf"),
                .copy("Resources/Epilogue-Bold.ttf"),
                .copy("Resources/AppIcon.icns")
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .testTarget(
            name: "ExeWatcherMenubarTests",
            dependencies: ["ExeWatcherMenubar"],
            path: "Tests/ExeWatcherMenubarTests"
        ),
        .testTarget(
            name: "ExeWatcherUITests",
            path: "Tests/ExeWatcherUITests"
        )
    ]
)
