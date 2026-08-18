/**
 * Minimal ambient types for `js-aruco2`, which ships no declarations.
 * Only the surface the pipeline actually touches is declared.
 */
declare module 'js-aruco2/src/aruco.js' {
  export interface ArucoPoint {
    x: number;
    y: number;
  }

  export interface ArucoMarker {
    id: number;
    /** Four polygon corners, clockwise in image space. */
    corners: ArucoPoint[];
    hammingDistance: number;
  }

  export interface ArucoDictionary {
    nBits: number;
    tau: number | null;
    /** One bit-string per id; `'1'` == white cell. */
    codeList: string[];
  }

  export interface ArucoDetectorConfig {
    dictionaryName?: string;
    maxHammingDistance?: number;
  }

  export interface ArucoDetector {
    detectImage(width: number, height: number, data: Uint8ClampedArray): ArucoMarker[];
  }

  export interface ArucoNamespace {
    DICTIONARIES: Record<string, unknown>;
    Dictionary: new (name: string) => ArucoDictionary;
    Detector: new (config?: ArucoDetectorConfig) => ArucoDetector;
    Marker: new (id: number, corners: ArucoPoint[], hammingDistance: number) => ArucoMarker;
  }

  const mod: { AR: ArucoNamespace };
  export default mod;
}

declare module 'js-aruco2/src/dictionaries/aruco_4x4_1000.js' {
  const mod: unknown;
  export default mod;
}
