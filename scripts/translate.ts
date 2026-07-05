import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a professional translator specializing in food and travel content.
Translate the following JSON content from English to natural, conversational Japanese.

RULES:
- Keep restaurant names in English (e.g., "Pepper Lunch" stays "Pepper Lunch")
- Use katakana for Hawaiian food terms: ポケ (poke), マラサダ (malasada), シェイブアイス (shave ice), プレートランチ (plate lunch)
- Keep place names recognizable: ワイキキ (Waikiki), ホノルル (Honolulu), オアフ島 (Oahu), ノースショア (North Shore), カカアコ (Kakaako)
- Maintain the casual, friendly, local food blogger tone
- Keep dollar amounts as-is (e.g., "$12-18")
- For SEO keywords in metadata, translate to natural Japanese search terms
- Return ONLY valid JSON — no markdown, no explanation
- Keep the exact same JSON structure and keys (keys stay in English)`

async function translateFile(inputPath: string, outputPath: string) {
  const content = fs.readFileSync(inputPath, 'utf-8')

  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Translate this JSON to Japanese:\n\n${content}`
      }
    ]
  })

  const translated = (message.content[0] as any).text
  // Clean up if wrapped in code blocks
  const cleanJson = translated.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

  // Validate JSON
  JSON.parse(cleanJson)

  fs.writeFileSync(outputPath, cleanJson, 'utf-8')
  console.log(`✅ Translated: ${path.basename(inputPath)}`)
}

async function translateAll() {
  const enDir = path.join(process.cwd(), 'translations/en')
  const jpDir = path.join(process.cwd(), 'translations/jp')

  if (!fs.existsSync(jpDir)) fs.mkdirSync(jpDir, { recursive: true })

  const files = fs.readdirSync(enDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const inputPath = path.join(enDir, file)
    const outputPath = path.join(jpDir, file)

    // Skip if already translated (remove this check to re-translate)
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping (exists): ${file}`)
      continue
    }

    try {
      await translateFile(inputPath, outputPath)
    } catch (error) {
      console.error(`❌ Failed: ${file}`, error)
    }

    // Rate limiting — wait 1 second between API calls
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  console.log('\n🎉 Translation complete!')
}

translateAll()
