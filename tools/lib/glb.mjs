// Minimal glTF 2.0 / GLB writer.
//
// Everything downstream needs is a binary buffer plus a JSON description of how
// to read it, so rather than pull in an exporter that expects a DOM we build the
// container directly. Chunk layout is from the glTF 2.0 spec, section 4.4.

const COMPONENT_TYPE = {
  i8: 5120,
  u8: 5121,
  i16: 5122,
  u16: 5123,
  u32: 5125,
  f32: 5126,
};

const COMPONENT_COUNT = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function componentTypeOf(array) {
  if (array instanceof Float32Array) return COMPONENT_TYPE.f32;
  if (array instanceof Uint32Array) return COMPONENT_TYPE.u32;
  if (array instanceof Uint16Array) return COMPONENT_TYPE.u16;
  if (array instanceof Uint8Array) return COMPONENT_TYPE.u8;
  if (array instanceof Int16Array) return COMPONENT_TYPE.i16;
  if (array instanceof Int8Array) return COMPONENT_TYPE.i8;
  throw new Error(`unsupported array type: ${array.constructor.name}`);
}

export class GLTFBuilder {
  constructor(generator = 'vigilant-train procedural asset pipeline') {
    this.json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: [],
    };
    this.blobs = [];
    this.byteLength = 0;
  }

  _align4() {
    const remainder = this.byteLength % 4;
    if (remainder === 0) return;
    const pad = 4 - remainder;
    this.blobs.push(Buffer.alloc(pad));
    this.byteLength += pad;
  }

  _addBufferView(array, target) {
    // Accessor byteOffset must be a multiple of both 4 and the component size.
    // Giving every accessor its own 4-aligned view satisfies that unconditionally.
    this._align4();
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const byteOffset = this.byteLength;
    this.blobs.push(bytes);
    this.byteLength += bytes.length;

    const view = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (target !== undefined) view.target = target;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  addAccessor(array, type, { target, normalized = false, computeBounds = false } = {}) {
    const componentCount = COMPONENT_COUNT[type];
    if (!componentCount) throw new Error(`unknown accessor type: ${type}`);
    if (array.length % componentCount !== 0) {
      throw new Error(`array length ${array.length} is not a multiple of ${componentCount} for ${type}`);
    }

    const count = array.length / componentCount;
    const accessor = {
      bufferView: this._addBufferView(array, target),
      componentType: componentTypeOf(array),
      count,
      type,
    };
    if (normalized) accessor.normalized = true;

    // POSITION accessors are required to carry min/max; it is optional elsewhere
    // but viewers use it for frustum culling so it is cheap to always provide.
    if (computeBounds) {
      const min = new Array(componentCount).fill(Infinity);
      const max = new Array(componentCount).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < componentCount; c++) {
          const value = array[i * componentCount + c];
          if (value < min[c]) min[c] = value;
          if (value > max[c]) max[c] = value;
        }
      }
      accessor.min = min;
      accessor.max = max;
    }

    this.json.accessors.push(accessor);
    return this.json.accessors.length - 1;
  }

  addVertexAccessor(array, type, opts = {}) {
    return this.addAccessor(array, type, { ...opts, target: ARRAY_BUFFER });
  }

  addIndexAccessor(array) {
    return this.addAccessor(array, 'SCALAR', { target: ELEMENT_ARRAY_BUFFER });
  }

  addMaterial(material) {
    this.json.materials.push(material);
    return this.json.materials.length - 1;
  }

  addMesh(mesh) {
    this.json.meshes.push(mesh);
    return this.json.meshes.length - 1;
  }

  addNode(node) {
    this.json.nodes.push(node);
    return this.json.nodes.length - 1;
  }

  addSkin(skin) {
    if (!this.json.skins) this.json.skins = [];
    this.json.skins.push(skin);
    return this.json.skins.length - 1;
  }

  addAnimation(animation) {
    if (!this.json.animations) this.json.animations = [];
    this.json.animations.push(animation);
    return this.json.animations.length - 1;
  }

  addSceneNode(index) {
    this.json.scenes[0].nodes.push(index);
  }

  toGLB() {
    this._align4();
    this.json.buffers = [{ byteLength: this.byteLength }];

    // Drop empty optional arrays; the spec forbids zero-length ones.
    for (const key of ['skins', 'animations', 'materials', 'meshes', 'accessors', 'bufferViews']) {
      if (Array.isArray(this.json[key]) && this.json[key].length === 0) delete this.json[key];
    }

    const binChunk = Buffer.concat(this.blobs, this.byteLength);

    // The JSON chunk pads with spaces, the binary chunk with zeroes.
    let jsonChunk = Buffer.from(JSON.stringify(this.json), 'utf8');
    const jsonPad = (4 - (jsonChunk.length % 4)) % 4;
    if (jsonPad) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPad, 0x20)]);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); // "glTF"
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonChunk.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"

    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binChunk.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

    return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
  }
}
