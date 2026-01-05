/**
 * API ROUTES FOR ENRICHMENT AND DISCREPANCY DETECTION
 * 
 * Add to server.js:
 *   const enrichmentRoutes = require('./routes/enrichment_routes');
 *   app.use('/api', enrichmentRoutes);
 */

const express = require('express');
const router = express.Router();

// Import enrichment modules
const { 
  triggerEnrichment, 
  getEnrichmentStatus, 
  getQueueStatus,
  processNewManagers 
} = require('../enrichment/realtime_enrichment');

const {
  detectAllDiscrepancies,
  detectNeedsInitialADV,
  detectOverdueAnnualADV,
  detectVCExemptionViolations,
  detectFundTypeMismatches,
  detectMissingFundsInADV,
  detectExemptionMismatches,
  DISCREPANCY_TYPES
} = require('../enrichment/discrepancy_detector');

// ============================================================================
// ENRICHMENT ENDPOINTS
// ============================================================================

/**
 * GET /api/enrichment/status
 * Get overall enrichment queue status
 */
router.get('/enrichment/status', async (req, res) => {
  try {
    const status = await getQueueStatus();
    res.json(status);
  } catch (error) {
    console.error('[API] Error getting enrichment status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/enrichment/manager/:name
 * Get enrichment status for a specific manager
 */
router.get('/enrichment/manager/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const status = await getEnrichmentStatus(decodeURIComponent(name));
    res.json(status);
  } catch (error) {
    console.error('[API] Error getting manager enrichment:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/enrichment/trigger
 * Manually trigger enrichment for a specific manager
 */
router.post('/enrichment/trigger', async (req, res) => {
  try {
    const { manager_name } = req.body;
    
    if (!manager_name) {
      return res.status(400).json({ error: 'manager_name required' });
    }
    
    const result = await triggerEnrichment(manager_name);
    res.json(result);
  } catch (error) {
    console.error('[API] Error triggering enrichment:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/enrichment/process-new
 * Process new managers (trigger batch enrichment)
 */
router.post('/enrichment/process-new', async (req, res) => {
  try {
    const result = await processNewManagers();
    res.json(result);
  } catch (error) {
    console.error('[API] Error processing new managers:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DISCREPANCY DETECTION ENDPOINTS
// ============================================================================

/**
 * GET /api/discrepancies
 * Get all discrepancies with optional filtering
 */
router.get('/discrepancies', async (req, res) => {
  try {
    const { type, severity, limit = 100 } = req.query;
    
    // Parse types if provided
    const types = type ? type.split(',').map(t => t.toUpperCase()) : null;
    
    const { discrepancies, summary } = await detectAllDiscrepancies({ types });
    
    // Filter by severity if provided
    let filtered = discrepancies;
    if (severity) {
      filtered = discrepancies.filter(d => d.severity === severity.toLowerCase());
    }
    
    // Apply limit
    filtered = filtered.slice(0, parseInt(limit));
    
    res.json({
      total: filtered.length,
      summary,
      discrepancies: filtered
    });
  } catch (error) {
    console.error('[API] Error detecting discrepancies:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/types
 * Get available discrepancy types
 */
router.get('/discrepancies/types', (req, res) => {
  res.json(DISCREPANCY_TYPES);
});

/**
 * GET /api/discrepancies/needs-initial-adv
 * Get managers who need to file initial Form ADV
 */
router.get('/discrepancies/needs-initial-adv', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const discrepancies = await detectNeedsInitialADV();
    res.json({
      total: discrepancies.length,
      discrepancies: discrepancies.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/overdue-annual-adv
 * Get advisers with overdue annual Form ADV amendments
 */
router.get('/discrepancies/overdue-annual-adv', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const discrepancies = await detectOverdueAnnualADV();
    res.json({
      total: discrepancies.length,
      discrepancies: discrepancies.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/vc-exemption-violations
 * Get VC exemption violations
 */
router.get('/discrepancies/vc-exemption-violations', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const discrepancies = await detectVCExemptionViolations();
    res.json({
      total: discrepancies.length,
      discrepancies: discrepancies.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/fund-type-mismatches
 * Get fund type mismatches
 */
router.get('/discrepancies/fund-type-mismatches', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const discrepancies = await detectFundTypeMismatches();
    res.json({
      total: discrepancies.length,
      discrepancies: discrepancies.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/missing-funds
 * Get funds missing from Form ADV
 */
router.get('/discrepancies/missing-funds', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const discrepancies = await detectMissingFundsInADV();
    res.json({
      total: discrepancies.length,
      discrepancies: discrepancies.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/exemption-mismatches
 * Get exemption mismatches (3(c)(1) vs 3(c)(7))
 */
router.get('/discrepancies/exemption-mismatches', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const discrepancies = await detectExemptionMismatches();
    res.json({
      total: discrepancies.length,
      discrepancies: discrepancies.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discrepancies/summary
 * Get summary of all discrepancy types
 */
router.get('/discrepancies/summary', async (req, res) => {
  try {
    const { discrepancies, summary } = await detectAllDiscrepancies();
    
    // Add sample for each type
    const typesSummary = {};
    for (const [type, count] of Object.entries(summary.by_type)) {
      const sample = discrepancies.find(d => d.type === type);
      typesSummary[type] = {
        count,
        severity: DISCREPANCY_TYPES[type]?.severity || 'unknown',
        description: DISCREPANCY_TYPES[type]?.description || '',
        sample: sample ? {
          entity_name: sample.entity_name,
          details: sample.details?.description
        } : null
      };
    }
    
    res.json({
      total: summary.total,
      by_severity: summary.by_severity,
      by_type: typesSummary
    });
  } catch (error) {
    console.error('[API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
