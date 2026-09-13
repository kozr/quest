import AppKit
import SceneKit
import Metal
import simd
import CryptoKit

// Quest art study. One chest, three hinge poses, three modular environments.
// Run from this directory; all scene geometry is authored here, without generated textures.
let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "renders", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255)/255, green: CGFloat((hex >> 8) & 255)/255,
            blue: CGFloat(hex & 255)/255, alpha: 1)
}
func material(_ name: String, _ hex: UInt32) -> SCNMaterial {
    let m = SCNMaterial(); m.name = name; m.diffuse.contents = color(hex)
    m.lightingModel = .physicallyBased; m.roughness.contents = 0.78; m.metalness.contents = 0.0
    return m
}
let navy = material("Midnight enamel", 0x233D51)
let navyLight = material("Raised blue panels", 0x36556B)
let navyDark = material("Deep seams", 0x132A39)
let gold = material("Warm brass", 0xD5AA5D)
let goldLight = material("Brass edge", 0xF1CA79)
let interior = material("Chest interior", 0x1C3038)
let moss = material("Moss", 0x748A64)
let forest = material("Pine", 0x305F53)
let pineLight = material("Pine tips", 0x4A7961)
let bark = material("Bark", 0x655346)
let rock = material("Stone", 0x93968B)
let rockDark = material("Stone sides", 0x626F70)
let sand = material("Pale path", 0xC8B991)
let water = material("Sea", 0x648C96)
let cream = material("Lighthouse ivory", 0xE2DDC8)
let coral = material("Flag ochre", 0xBD754C)

@discardableResult
func box(_ parent: SCNNode, _ name: String, _ size: SCNVector3, _ p: SCNVector3,
         _ m: SCNMaterial, bevel: CGFloat = 0.025) -> SCNNode {
    let g = SCNBox(width: CGFloat(size.x), height: CGFloat(size.y), length: CGFloat(size.z), chamferRadius: bevel)
    g.chamferSegmentCount = 1; g.materials = [m]
    let n = SCNNode(geometry:g); n.name = name; n.position = p; parent.addChildNode(n); return n
}
@discardableResult
func cylinder(_ parent: SCNNode, _ name: String, _ radius: CGFloat, _ height: CGFloat,
              _ p: SCNVector3, _ m: SCNMaterial, sides: Int = 12) -> SCNNode {
    let g = SCNCylinder(radius:radius, height:height); g.radialSegmentCount = sides; g.materials = [m]
    let n = SCNNode(geometry:g); n.name = name; n.position = p; parent.addChildNode(n); return n
}
func cone(_ parent: SCNNode, _ bottom: CGFloat, _ top: CGFloat, _ height: CGFloat,
          _ p: SCNVector3, _ m: SCNMaterial, sides: Int = 7) {
    let g = SCNCone(topRadius:top, bottomRadius:bottom, height:height)
    g.radialSegmentCount = sides; g.materials = [m]
    let n = SCNNode(geometry:g); n.position = p; parent.addChildNode(n)
}
func stone(_ parent: SCNNode, _ p: SCNVector3, _ s: Float, _ rotation: Float = 0) {
    let g = SCNSphere(radius:CGFloat(s)); g.segmentCount = 6; g.materials = [rock]
    let n = SCNNode(geometry:g); n.position = p; n.scale = SCNVector3(1,0.62,0.77)
    n.eulerAngles.y = CGFloat(rotation); parent.addChildNode(n)
}
func tree(_ parent: SCNNode, _ x: Float, _ z: Float, _ scale: Float) {
    let n = SCNNode(); n.position = SCNVector3(x,0.08,z); n.scale = SCNVector3(scale,scale,scale)
    parent.addChildNode(n)
    cylinder(n,"Trunk",0.065,0.55,SCNVector3(0,0.25,0),bark,sides:7)
    cone(n,0.43,0.025,0.74,SCNVector3(0,0.71,0),forest)
    cone(n,0.32,0.015,0.65,SCNVector3(0,1.02,0),pineLight)
}

// Extruded, faceted barrel-lid profile. Flat normals preserve the shape language.
func lidMesh(width: Float, lift: Float = 0) -> SCNGeometry {
    let bottom:Float = lift > 0 ? -0.012 : 0
    let profile: [SIMD2<Float>] = [
        SIMD2(0,bottom), SIMD2(1.16,bottom), SIMD2(1.16,0.10+lift),
        SIMD2(1.06,0.30+lift), SIMD2(0.85,0.47+lift), SIMD2(0.58,0.53+lift),
        SIMD2(0.31,0.47+lift), SIMD2(0.10,0.30+lift), SIMD2(0,0.10+lift)
    ]
    var vertices:[SCNVector3] = []; var normals:[SCNVector3] = []; var indices:[Int32] = []
    func triangle(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) {
        let normal = simd_normalize(simd_cross(c-a,b-a)); let base = Int32(vertices.count)
        vertices += [SCNVector3(a),SCNVector3(c),SCNVector3(b)]
        normals += Array(repeating:SCNVector3(normal),count:3)
        indices += [base,base+1,base+2]
    }
    let count = profile.count
    func v(_ i:Int,_ x:Float) -> SIMD3<Float> { SIMD3(x,profile[i].y,profile[i].x) }
    for i in 0..<count {
        let j=(i+1)%count
        triangle(v(i,-width/2),v(j,-width/2),v(j,width/2))
        triangle(v(i,-width/2),v(j,width/2),v(i,width/2))
    }
    for i in 1..<(count-1) {
        triangle(v(0,-width/2),v(i+1,-width/2),v(i,-width/2))
        triangle(v(0,width/2),v(i,width/2),v(i+1,width/2))
    }
    let g = SCNGeometry(sources:[SCNGeometrySource(vertices:vertices), SCNGeometrySource(normals:normals)],
                        elements:[SCNGeometryElement(indices:indices,primitiveType:.triangles)])
    return g
}

let chest = SCNNode(); chest.name = "Quest master chest"
let hinge = SCNNode(); hinge.name = "Lid hinge — the only animated transform"
hinge.position = SCNVector3(0,1.06,-0.58)
chest.addChildNode(hinge)

// Four walls and a floor; the container remains hollow when open.
box(chest,"Floor",SCNVector3(1.86,0.14,1.16),SCNVector3(0,0.22,0),navyDark)
box(chest,"Front wall",SCNVector3(1.86,0.77,0.12),SCNVector3(0,0.635,0.52),navy)
box(chest,"Back wall",SCNVector3(1.86,0.77,0.12),SCNVector3(0,0.635,-0.52),navy)
for x: Float in [-0.87,0.87] {
    box(chest,"Side wall",SCNVector3(0.12,0.77,1.04),SCNVector3(x,0.635,0),navyLight)
}
box(chest,"Interior floor",SCNVector3(1.58,0.025,0.9),SCNVector3(0,0.30,0),interior,bevel:0)
for x: Float in [-0.77,0.77] {
    for z: Float in [-0.43,0.43] {
        box(chest,"Foot",SCNVector3(0.24,0.20,0.23),SCNVector3(x,0.12,z),gold)
    }
}
for y:Float in [0.32,0.98] {
    box(chest,"Front rim",SCNVector3(1.93,0.075,0.055),SCNVector3(0,y,0.59),gold)
    box(chest,"Back rim",SCNVector3(1.93,0.075,0.055),SCNVector3(0,y,-0.59),gold)
    for x:Float in [-0.94,0.94] {
        box(chest,"Side rim",SCNVector3(0.055,0.075,1.19),SCNVector3(x,y,0),gold)
    }
}
for x:Float in [-0.65,0.65] {
    for z:Float in [-0.60,0.60] {
        box(chest,"Vertical band",SCNVector3(0.14,0.69,0.05),SCNVector3(x,0.65,z),gold)
        for y:Float in [0.43,0.85] {
            let rivet=cylinder(chest,"Band rivet",0.037,0.022,SCNVector3(x,y,z+(z>0 ? 0.032 : -0.032)),goldLight,sides:8)
            rivet.eulerAngles.x = .pi/2
        }
    }
}
// Inset panel seams are geometry, not a random wood texture.
for y:Float in [0.53,0.74] {
    box(chest,"Front panel seam",SCNVector3(1.70,0.014,0.008),SCNVector3(0,y,0.585),navyDark,bevel:0)
}
let lid=SCNNode(geometry:lidMesh(width:1.89)); lid.name="Master lid"; lid.geometry?.materials=[navy]
hinge.addChildNode(lid)
for x:Float in [-0.65,0.65] {
    let band=SCNNode(geometry:lidMesh(width:0.145,lift:0.023)); band.name="Lid brass band"
    band.position.x=CGFloat(x); band.geometry?.materials=[gold]; hinge.addChildNode(band)
}
// Latch attached to lid, with one cutout-like dark keyhole and a diamond signature.
box(hinge,"Latch",SCNVector3(0.27,0.34,0.075),SCNVector3(0,-0.01,1.195),gold,bevel:0.04)
let hole=cylinder(hinge,"Keyhole circle",0.038,0.006,SCNVector3(0,0.005,1.237),navyDark,sides:12)
hole.eulerAngles.x = .pi/2
box(hinge,"Keyhole stem",SCNVector3(0.034,0.066,0.008),SCNVector3(0,-0.043,1.238),navyDark,bevel:0.004)
let crest=box(hinge,"Diamond hallmark",SCNVector3(0.115,0.115,0.018),SCNVector3(0,0.345,1.027),goldLight,bevel:0.006)
crest.eulerAngles.x = -.pi/4; crest.eulerAngles.z = .pi/4
for x:Float in [-0.62,0.62] {
    let pin=cylinder(chest,"Hinge pin",0.054,0.23,SCNVector3(x,1.06,-0.58),gold,sides:10)
    pin.eulerAngles.z = .pi/2
}
// Coins remain the same in all poses, physically occluded by the closed lid.
let coinPositions:[(Float,Float,Float)] = [(-0.5,0.36,0.20),(-0.21,0.38,0.22),(0.10,0.37,0.21),(0.43,0.35,0.20),
    (-0.41,0.42,-0.09),(-0.03,0.43,-0.10),(0.34,0.41,-0.08),(-0.20,0.49,0.05),(0.16,0.49,0.06)]
for (i,p) in coinPositions.enumerated() {
    let coin=cylinder(chest,"Coin \(i)",0.17,0.048,SCNVector3(p.0,p.1+0.40,p.2),i%2==0 ? gold:goldLight,sides:12)
    coin.eulerAngles = SCNVector3(Float(i%3)*0.08,Float(i)*0.3,Float(i%2)*0.12)
}

let scene=SCNScene(); scene.rootNode.addChildNode(chest)
scene.background.contents=color(0xF0EDE5)
scene.lightingEnvironment.intensity=0
let camera=SCNNode(); camera.name="Locked orthographic camera"; camera.camera=SCNCamera()
camera.camera!.usesOrthographicProjection=true; camera.camera!.orthographicScale=2.8
camera.camera!.zNear=0.1; camera.camera!.zFar=100
camera.camera!.wantsHDR=false; camera.camera!.wantsExposureAdaptation=false
camera.position=SCNVector3(5,4.1,6.6); camera.look(at:SCNVector3(0,0.72,0))
scene.rootNode.addChildNode(camera)
let key=SCNNode(); key.name="Locked key light"; key.light=SCNLight(); key.light!.type = .directional
key.light!.intensity=1100; key.light!.color=color(0xFFF2D9); key.light!.castsShadow=true
key.light!.shadowMode = .deferred; key.light!.shadowRadius=5; key.light!.shadowSampleCount=32
key.light!.shadowMapSize=CGSize(width:2048,height:2048); key.light!.shadowColor=NSColor.black.withAlphaComponent(0.20)
key.light!.orthographicScale=7; key.position=SCNVector3(-3,7,5); key.look(at:SCNVector3Zero)
scene.rootNode.addChildNode(key)
let ambient=SCNNode(); ambient.name="Locked ambient fill"; ambient.light=SCNLight()
ambient.light!.type = .ambient; ambient.light!.intensity=450; ambient.light!.color=color(0xE7EEF1)
scene.rootNode.addChildNode(ambient)

func environment(_ kind:Int) -> SCNNode {
    let n=SCNNode(); n.name=["Forest clearing","Stone ruins","Coastal lookout"][kind]
    let base=cylinder(n,"Octagonal terrain",2.02,0.22,SCNVector3(0,-0.095,0),kind==0 ? moss : kind==1 ? rockDark : sand,sides:10)
    base.eulerAngles.y = .pi/10
    if kind==0 {
        tree(n,-1.34,-0.65,1.08); tree(n,0.77,-1.13,0.93); tree(n,1.47,-0.40,0.58)
        for (x,z): (Float,Float) in [(-0.25,1.07),(-0.40,1.36),(-0.56,1.61)] {
            let p=cylinder(n,"Stepping stone",0.19,0.035,SCNVector3(x,0.04,z),sand,sides:7); p.scale.z=0.68
        }
        stone(n,SCNVector3(-1.25,0.11,0.55),0.26,0.3); stone(n,SCNVector3(1.24,0.09,0.64),0.22,1)
    } else if kind==1 {
        for x:Float in [-1.13,1.13] {
            box(n,"Pillar plinth",SCNVector3(0.50,0.14,0.51),SCNVector3(x,0.11,-0.92),rock)
            cylinder(n,"Octagonal pillar",0.19,x<0 ? 1.55:1.16,SCNVector3(x,x<0 ? 0.94:0.745,-0.92),rock,sides:8)
            box(n,"Pillar capital",SCNVector3(0.45,0.17,0.44),SCNVector3(x,x<0 ? 1.73:1.34,-0.92),sand)
        }
        for i in 0..<4 {
            let b=box(n,"Fallen masonry",SCNVector3(0.32,0.18,0.25),SCNVector3(1.34-Float(i%2)*0.25,0.11+Float(i/2)*0.15,0.45+Float(i%2)*0.32),rock)
            b.eulerAngles.y=CGFloat(i)*0.4
        }
        for z:Float in [1.07,1.39] { box(n,"Courtyard slab",SCNVector3(0.52,0.035,0.27),SCNVector3(-0.25,0.04,z),sand,bevel:0.03) }
        cone(n,0.22,0,0.40,SCNVector3(-1.44,0.22,0.5),forest,sides:6)
    } else {
        let sea=cylinder(n,"Tide pool",0.73,0.024,SCNVector3(-1.09,0.035,0.48),water,sides:10); sea.scale.z=0.65
        let tower=SCNNode(); tower.position=SCNVector3(0.88,0.06,-1.09); n.addChildNode(tower)
        cone(tower,0.28,0.19,1.12,SCNVector3(0,0.56,0),cream,sides:10)
        cylinder(tower,"Lantern ledge",0.27,0.065,SCNVector3(0,1.13,0),navy,sides:10)
        cylinder(tower,"Lantern housing",0.16,0.25,SCNVector3(0,1.29,0),goldLight,sides:8)
        cone(tower,0.27,0,0.24,SCNVector3(0,1.51,0),navy,sides:8)
        stone(n,SCNVector3(-1.3,0.12,-0.70),0.37,0.2)
        stone(n,SCNVector3(1.41,0.10,0.48),0.24,0.5)
        cylinder(n,"Flagpole",0.024,1.01,SCNVector3(-0.85,0.56,-1.17),bark,sides:8)
        box(n,"Pennant",SCNVector3(0.37,0.21,0.024),SCNVector3(-0.66,0.93,-1.17),coral,bevel:0.005)
        for z:Float in [1.01,1.22,1.43] {box(n,"Boardwalk",SCNVector3(0.61,0.04,0.13),SCNVector3(-0.15,0.055,z),bark,bevel:0.012)}
    }
    // Background props do not cast changing shadows onto the subject.
    n.enumerateChildNodes { node,_ in node.castsShadow=false }
    return n
}

guard let device=MTLCreateSystemDefaultDevice() else { fatalError("Metal device unavailable; render requires local GPU access.") }
let renderer=SCNRenderer(device:device,options:nil); renderer.scene=scene; renderer.pointOfView=camera
renderer.autoenablesDefaultLighting=false

func save(_ image:NSImage,_ url:URL) throws {
    guard let data=image.tiffRepresentation, let bitmap=NSBitmapImageRep(data:data),
          let png=bitmap.representation(using:.png,properties:[:]) else {fatalError("PNG conversion failed")}
    try png.write(to:url)
}
func render(_ url:URL,_ size:Int=1000) throws {
    try save(renderer.snapshot(atTime:0,with:CGSize(width:size,height:size),antialiasingMode:.multisampling4X),url)
}

// Fingerprint scene geometry/material data, excluding the single intended animated transform.
func fingerprint(_ node:SCNNode) -> String {
    var bytes=Data()
    node.enumerateHierarchy { n,_ in
        bytes.append(Data((n.name ?? "").utf8))
        if let g=n.geometry {
            for source in g.sources { bytes.append(source.data) }
            for element in g.elements { bytes.append(element.data) }
            for m in g.materials {
                bytes.append(Data((m.name ?? "").utf8))
                if let c=(m.diffuse.contents as? NSColor)?.usingColorSpace(.sRGB) {
                    bytes.append(Data("\(c.redComponent),\(c.greenComponent),\(c.blueComponent),\(m.roughness.contents ?? ""),\(m.metalness.contents ?? "")".utf8))
                }
            }
        }
        if n !== hinge {bytes.append(Data("\(n.position),\(n.eulerAngles),\(n.scale)".utf8))}
    }
    return SHA256.hash(data:bytes).map {String(format:"%02x",$0)}.joined()
}
let masterHash=fingerprint(chest)
var checks:[[String:Any]]=[]
let names=["forest","ruins","coast"]
let poses:[(String,CGFloat)]=[("closed",0),("opening",45),("open",100)]
var current:SCNNode?
for e in 0..<3 {
    current?.removeFromParentNode(); current=environment(e); scene.rootNode.addChildNode(current!)
    for (pose,angle) in poses {
        hinge.eulerAngles.x = -angle * .pi/180
        let hash=fingerprint(chest); precondition(hash==masterHash,"Chest asset changed")
        try render(output.appendingPathComponent("\(names[e])-\(pose).png"))
        checks.append(["environment":names[e],"pose":pose,"lidDegrees":angle,"assetSHA256":hash])
        print("Rendered \(names[e])-\(pose)")
    }
}
// Re-render the same reference pose to check reproducibility on this renderer.
current?.removeFromParentNode(); current=environment(0); scene.rootNode.addChildNode(current!)
hinge.eulerAngles.x=0
try render(output.appendingPathComponent("forest-closed-repeat.png"))
let original=try Data(contentsOf:output.appendingPathComponent("forest-closed.png"))
let repeated=try Data(contentsOf:output.appendingPathComponent("forest-closed-repeat.png"))

let report:[String:Any]=["assetSHA256":masterHash,"renders":checks,
    "repeatPNGBytesEqual":original==repeated,"renderer":"SceneKit / Metal",
    "device":device.name,"camera":"Orthographic; scale 2.8; position 5,4.1,6.6; target 0,0.72,0",
    "lighting":"Fixed directional key 1100 and ambient fill 450; no exposure adaptation",
    "scope":"Geometry, materials, camera and lights locked. Only lid angle and surroundings change."]
try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("consistency-report.json"))

// Export the reusable master chest separately from the art-study environment.
let asset=SCNScene(); asset.rootNode.addChildNode(chest.clone())
precondition(asset.write(to:output.appendingPathComponent("quest-chest.scn"),options:nil,delegate:nil,progressHandler:nil))
precondition(asset.write(to:output.appendingPathComponent("quest-chest.dae"),options:nil,delegate:nil,progressHandler:nil))

// A short deterministic opening loop for judging the actual hinge, rather than frame drift.
let frames=output.appendingPathComponent("frames",isDirectory:true)
try FileManager.default.createDirectory(at:frames,withIntermediateDirectories:true)
for i in 0..<60 {
    let t=max(0,min(1,(Double(i)-9)/30)); let eased=1-pow(1-t,3)
    hinge.eulerAngles.x = -CGFloat(eased)*100 * .pi/180
    try render(frames.appendingPathComponent(String(format:"%03d.png",i)),640)
}
print("Consistency report: \(original==repeated ? "repeat PNG matches" : "repeat PNG differs; inspect pixel comparison")")
