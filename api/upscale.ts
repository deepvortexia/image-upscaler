import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('[upscale] Request received:', { method: req.method })

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { imageBase64, mimeType, scale = 4 } = req.body

  if (!imageBase64) {
    return res.status(400).json({ error: 'Image is required' })
  }

  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'Please sign in to upscale images' })
  }

  const apiKey = process.env.REPLICATE_API_TOKEN
  if (!apiKey) {
    return res.status(500).json({ error: 'Replicate API key not configured' })
  }

  console.log('[upscale] API key check:', apiKey ? `loaded (${apiKey.slice(0, 8)}...)` : 'MISSING')

  let userId: string
  let currentCredits: number

  try {
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid authentication token' })
    }

    userId = user.id
    console.log('[upscale] User verified:', { userId: user.id })

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', user.id)
      .single()

    if (profileError) {
      return res.status(500).json({ error: 'Failed to fetch user profile' })
    }

    if (!profile || profile.credits < 1) {
      return res.status(402).json({ error: 'Insufficient credits. Please purchase more credits to continue.' })
    }

    currentCredits = profile.credits

    const { data: updatedProfile, error: updateError } = await supabase
      .from('profiles')
      .update({
        credits: profile.credits - 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .eq('credits', profile.credits)
      .select()
      .single()

    if (updateError || !updatedProfile) {
      return res.status(409).json({ error: 'Credit check failed, please try again' })
    }
  } catch (error: any) {
    console.error('[upscale] Auth error:', error)
    return res.status(500).json({ error: 'Failed to verify credits' })
  }

  let generationFailed = false

  try {
    const imageDataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`
    const scaleValue = Number(scale) || 4

    const response = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        version: '42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
        input: {
          image: imageDataUrl,
          scale: scaleValue,
        },
      }),
    })

    const prediction = await response.json()
    console.log('[upscale] Replicate response:', { status: response.status, ok: response.ok })

    if (!response.ok) {
      generationFailed = true
      throw new Error(prediction.detail || 'Failed to create prediction')
    }

    // Poll for completion
    let result = prediction
    const pollStartTime = Date.now()

    while (result.status !== 'succeeded' && result.status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 1000))

      const pollResponse = await fetch(
        `https://api.replicate.com/v1/predictions/${result.id}`,
        { headers: { 'Authorization': `Token ${apiKey}` } }
      )

      if (!pollResponse.ok) {
        generationFailed = true
        throw new Error(`Failed to poll prediction status: ${pollResponse.status}`)
      }

      result = await pollResponse.json()
      console.log('[upscale] Poll result:', { status: result.status, id: result.id })

      if (Date.now() - pollStartTime > 100000) {
        generationFailed = true
        throw new Error('Processing timeout')
      }
    }

    if (result.status === 'failed') {
      generationFailed = true
      throw new Error(result.error || 'Image upscaling failed')
    }

    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output

    if (!outputUrl) {
      generationFailed = true
      throw new Error('No image returned from model')
    }

    // Fetch from Replicate and upload to Supabase Storage for a stable public URL
    const imgRes = await fetch(outputUrl)
    if (!imgRes.ok) {
      generationFailed = true
      throw new Error(`Failed to fetch upscaled image: ${imgRes.status}`)
    }
    const imgBuffer = await imgRes.arrayBuffer()
    const fileName = `${userId}/${Date.now()}-upscaled.png`
    const { error: uploadError } = await supabase.storage
      .from('generated-images')
      .upload(fileName, imgBuffer, { contentType: 'image/png', upsert: false })
    if (uploadError) {
      generationFailed = true
      throw new Error(`Storage upload failed: ${uploadError.message}`)
    }
    const { data: { publicUrl } } = supabase.storage
      .from('generated-images')
      .getPublicUrl(fileName)
    console.log('[upscale] Uploaded to Supabase Storage:', publicUrl)

    // Log transaction
    void supabase
      .from('generation_logs')
      .insert({ user_id: userId, tool: 'image-upscaler', created_at: new Date().toISOString() })

    return res.status(200).json({ image: publicUrl })
  } catch (error: any) {
    console.error('[upscale] Error:', error?.message)

    if (generationFailed) {
      try {
        await supabase
          .from('profiles')
          .update({ credits: currentCredits, updated_at: new Date().toISOString() })
          .eq('id', userId)
        console.log(`[upscale] Refunded credit to user ${userId}`)
      } catch (refundError) {
        console.error('[upscale] Failed to refund credit:', refundError)
      }
    }

    return res.status(500).json({ error: error.message || 'Failed to upscale image' })
  }
}
