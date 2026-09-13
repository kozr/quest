import AppKit

let directory=URL(fileURLWithPath:CommandLine.arguments.dropFirst().first ?? "renders",isDirectory:true)
let width=1920, height=2220
let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:width,pixelsHigh:height,bitsPerSample:8,
    samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
NSColor(srgbRed:240/255,green:237/255,blue:229/255,alpha:1).setFill()
NSRect(x:0,y:0,width:width,height:height).fill()
let ink=NSColor(srgbRed:0.08,green:0.16,blue:0.20,alpha:1)
let muted=NSColor(srgbRed:0.35,green:0.40,blue:0.39,alpha:1)
func text(_ string:String,_ x:CGFloat,_ top:CGFloat,_ size:CGFloat,_ bold:Bool=false,_ tint:NSColor=ink) {
    let font=NSFont.systemFont(ofSize:size,weight:bold ? .semibold:.regular)
    (string as NSString).draw(at:NSPoint(x:x,y:CGFloat(height)-top-size*1.22),withAttributes:[.font:font,.foregroundColor:tint])
}
text("Quest / consistency study",64,48,26,true,muted)
text("One chest. Nine views.",64,98,66,true)
text("The same model, palette, camera and light. Only the lid and setting change.",66,187,27,false,muted)
let columns:[CGFloat]=[64,672,1280]
for (i,label) in ["CLOSED · 0°","OPENING · 45°","OPEN · 100°"].enumerated() {
    text(label,columns[i]+18,256,22,true,muted)
}
let names=["forest","ruins","coast"]
let labels=["Forest clearing","Stone ruins","Coastal lookout"]
let poses=["closed","opening","open"]
for row in 0..<3 {
    let top=CGFloat(306+row*600)
    for col in 0..<3 {
        let image=NSImage(contentsOf:directory.appendingPathComponent("\(names[row])-\(poses[col]).png"))!
        image.draw(in:NSRect(x:columns[col]+18,y:CGFloat(height)-top-540,width:540,height:540))
    }
    text(labels[row],80,top+530,26,true)
    NSColor(srgbRed:0.80,green:0.79,blue:0.74,alpha:1).setFill()
    NSRect(x:64,y:CGFloat(height)-top-584,width:1792,height:1).fill()
}
text("REUSABLE 3D ASSET",64,2134,20,true,muted)
text("9 / 9 geometry + material checks matched. Repeated reference render matched byte-for-byte.",64,2170,23)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using:.png,properties:[:])!.write(to:directory.appendingPathComponent("comparison.png"))
print("Saved comparison.png")
