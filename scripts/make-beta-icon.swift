// Questline's orange campaign icon. Keep the established white Q mark.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let destination = CommandLine.arguments[1]
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
    bytesPerRow: 4096, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(colorSpace: colorSpace, components: [240.0 / 255, 90.0 / 255, 22.0 / 255, 1])!)
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
context.setStrokeColor(CGColor(gray: 1, alpha: 1))
context.setLineWidth(94)
context.strokeEllipse(in: CGRect(x: 268, y: 268, width: 488, height: 488))
context.setLineCap(.round)
context.move(to: CGPoint(x: 600, y: 392))
context.addLine(to: CGPoint(x: 780, y: 220))
context.strokePath()
let output = CGImageDestinationCreateWithURL(URL(fileURLWithPath: destination) as CFURL,
    UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(output, context.makeImage()!, nil)
guard CGImageDestinationFinalize(output) else { fatalError("Could not write Questline icon") }
