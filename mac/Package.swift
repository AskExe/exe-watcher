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
    targets: [
        .executableTarget(
            name: "ExeWatcherMenubar",
            path: "Sources/ExeWatcherMenubar",
            resources: [
                .copy("Resources/owl.pdf"),
                .copy("Resources/owl-menubar.pdf"),
                .copy("Resources/Epilogue-Bold.ttf"),
                .copy("Resources/odd-community-mark.png"),
                .copy("Resources/Satoshi-Regular.ttf"),
                .copy("Resources/Satoshi-Bold.ttf"),
                .copy("Resources/Grandstander-SemiBold.ttf"),
                .copy("Resources/Grandstander-Bold.ttf"),
                .copy("Resources/Grandstander-OFL.txt"),
                .copy("Resources/Satoshi-LICENSE-REFERENCE.txt"),
                .copy("Resources/AppIcon.icns")
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ]
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
