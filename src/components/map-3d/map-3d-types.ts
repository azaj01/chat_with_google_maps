/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Module augmentations for Google Maps types that are not yet available
 * in @types/google.maps.
 *
 * This file uses declaration merging to extend existing types without
 * causing conflicts.
 */

// Augment @vis.gl/react-google-maps with additional library overloads
declare module '@vis.gl/react-google-maps' {
  export function useMapsLibrary(name: 'maps3d'): google.maps.Maps3DLibrary | null;
  export function useMapsLibrary(name: 'elevation'): google.maps.ElevationLibrary | null;
  export function useMapsLibrary(name: 'places'): google.maps.PlacesLibrary | null;
  export function useMapsLibrary(name: 'geocoding'): google.maps.GeocodingLibrary | null;
}
