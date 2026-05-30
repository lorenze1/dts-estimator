const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '3.0', service: 'DTS AI Estimator' });
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const { data: proposals, error: pError } = await supabase
      .from('proposals')
      .select('id, status, created_at');
    
    const { data: scopeLib, error: sError } = await supabase
      .from('scope_library')
      .select('id');
    
    if (pError || sError) throw pError || sError;
    
    res.json({
      total_proposals: proposals.length,
      approved: proposals.filter(p => p.status === 'approved').length,
      pending: proposals.filter(p => p.status === 'pending').length,
      scope_items: scopeLib.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate estimate
app.post('/api/generate', async (req, res) => {
  try {
    const { jobDescription, photos, searchResults } = req.body;
    
    if (!jobDescription) {
      return res.status(400).json({ error: 'jobDescription is required' });
    }

    const { data: scopeItems } = await supabase
      .from('scope_library')
      .select('*')
      .limit(20);

    const { data: pricingHistory } = await supabase
      .from('pricing_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    let contextText = 'You are an expert estimator for Diversified Thermal Services LLC.\n\nJob Description: ' + jobDescription + '\n\n';

    if (scopeItems && scopeItems.length > 0) {
      contextText += 'Available Scope Items:\n' + scopeItems.map(s => '- ' + s.name + ': ' + s.description + ' (Unit: ' + s.unit + ', Base Price: $' + s.base_price + ')').join('\n') + '\n\n';
    }

    if (pricingHistory && pricingHistory.length > 0) {
      contextText += 'Recent Pricing History:\n' + pricingHistory.map(p => '- ' + p.item_name + ': $' + p.price + ' (' + p.job_type + ')').join('\n') + '\n\n';
    }

    if (searchResults) {
      contextText += 'Web Research Results:\n' + searchResults + '\n\n';
    }

    contextText += 'Generate a detailed estimate as JSON: { scope_items: [], materials: [], labor: [], equipment: [], total: number, timeline: string, notes: string }';

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: contextText }]
    });

    const responseText = message.content[0].text;
    
    let estimate;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      estimate = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: responseText };
    } catch (e) {
      estimate = { raw: responseText };
    }

    const { data: proposal, error: insertError } = await supabase
      .from('proposals')
      .insert({
        job_description: jobDescription,
        estimate_data: estimate,
        status: 'pending',
        ai_model: 'claude-opus-4-5'
      })
      .select()
      .single();

    if (insertError) throw insertError;

    res.json({
      proposal_id: proposal.id,
      estimate,
      created_at: proposal.created_at
    });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve estimate
app.post('/api/approve', async (req, res) => {
  try {
    const { proposal_id, adjustments } = req.body;
    
    if (!proposal_id) {
      return res.status(400).json({ error: 'proposal_id is required' });
    }

    const { data: proposal } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', proposal_id)
      .single();

    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const finalEstimate = adjustments || proposal.estimate_data;

    const { data: updated, error } = await supabase
      .from('proposals')
      .update({ 
        status: 'approved',
        final_data: finalEstimate,
        approved_at: new Date().toISOString()
      })
      .eq('id', proposal_id)
      .select()
      .single();

    if (error) throw error;

    if (finalEstimate.scope_items) {
      for (const item of finalEstimate.scope_items) {
        await supabase.from('pricing_history').insert({
          item_name: item.name || 'Unknown',
          price: item.cost || 0,
          job_type: proposal.job_description ? proposal.job_description.substring(0, 50) : 'General',
          proposal_id: proposal_id
        });
      }
    }

    res.json({ success: true, proposal: updated });

  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Analyze photos
app.post('/api/analyze-photos', async (req, res) => {
  try {
    const { photos, context } = req.body;
    
    if (!photos || !Array.isArray(photos)) {
      return res.status(400).json({ error: 'photos array is required' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const imageContent = photos.map(photo => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: photo.mediaType || 'image/jpeg',
        data: photo.data
      }
    }));

    imageContent.push({
      type: 'text',
      text: 'Analyze these job site photos. Context: ' + (context || 'General assessment') + '\n\nIdentify equipment, issues, safety concerns, and scope. Respond as JSON: { equipment: [], issues: [], safety_concerns: [], scope_notes: string, equipment_flags: [] }'
    });

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: imageContent }]
    });

    const responseText = message.content[0].text;
    let analysis;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: responseText };
    } catch (e) {
      analysis = { raw: responseText };
    }

    if (analysis.equipment_flags && analysis.equipment_flags.length > 0) {
      for (const flag of analysis.equipment_flags) {
        await supabase.from('equipment_flags').insert({
          flag_type: flag.type || 'general',
          description: flag.description || flag,
          severity: flag.severity || 'medium'
        });
      }
    }

    res.json({ analysis });

  } catch (err) {
    console.error('Photo analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Google search proxy
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const { data: cached } = await supabase
      .from('search_cache')
      .select('*')
      .eq('query', query)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (cached) {
      return res.json({ results: cached.results, cached: true });
    }

    const searchUrl = 'https://www.googleapis.com/customsearch/v1?key=' + process.env.GOOGLE_API_KEY + '&cx=' + process.env.GOOGLE_CSE_ID + '&q=' + encodeURIComponent(query);
    
    const response = await fetch(searchUrl);
    const data = await response.json();
    
    const results = data.items ? data.items.map(item => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet
    })) : [];

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    
    await supabase.from('search_cache').insert({
      query,
      results,
      expires_at: expiresAt.toISOString()
    });

    res.json({ results, cached: false });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('DTS AI Estimator v3 running on port ' + PORT);
});

module.exports = app;
