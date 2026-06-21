import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const sourceDir = path.join(root, 'node_modules', '@mediapipe', 'selfie_segmentation')
const targetDir = path.join(root, 'public', 'mediapipe')

const files = [
  'selfie_segmentation.js',
  'selfie_segmentation.binarypb',
  'selfie_segmentation.tflite',
  'selfie_segmentation_landscape.tflite',
  'selfie_segmentation_solution_wasm_bin.js',
  'selfie_segmentation_solution_wasm_bin.wasm',
  'selfie_segmentation_solution_simd_wasm_bin.data',
  'selfie_segmentation_solution_simd_wasm_bin.js',
  'selfie_segmentation_solution_simd_wasm_bin.wasm'
]

fs.mkdirSync(targetDir, { recursive: true })

for (const file of files) {
  const from = path.join(sourceDir, file)
  const to = path.join(targetDir, file)
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to)
    console.log(`Copied ${file}`)
  } else {
    console.warn(`Missing ${file} in ${sourceDir}`)
  }
}
