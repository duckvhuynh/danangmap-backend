declare module 'wkx' {
  export class Geometry {
    static parse(value: string | Buffer): Geometry;
    toGeoJSON(): Record<string, unknown>;
  }
}
