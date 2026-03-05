// =================================================================================
// === BLUE CARBON STRATIFIED RANDOM SAMPLING TOOL =================================
// =================================================================================

// =================================================================================
// === 1. CONFIGURATION ============================================================
// =================================================================================

var CONFIG = {
  // Analysis parameters
  ANALYSIS_SCALE: 250,           // 250m resolution for area calculations
  MAX_PIXELS: 1e10,
  MAX_ERROR: 1,
  DEFAULT_SEED: 42,
  
  // Sample size constraints
  MIN_TOTAL_SAMPLES: 10,
  MAX_TOTAL_SAMPLES: 10000,
  MIN_SAMPLES_PER_STRATUM: 3,    // UNFCCC minimum
  
  // Statistical defaults
  DEFAULT_CONFIDENCE: 90,
  DEFAULT_MARGIN_OF_ERROR: 20,
  
  // Sampling parameters
  RANDOM_BUFFER_M: 50,           // Inward buffer to avoid edge effects
  
  // Plot sizes per UNFCCC methodology
  PLOT_SIZES: {
    sediment_core: 0.01,         // 100 m² = 0.01 ha
    composite_plot: 0.025,       // 250 m² = 0.025 ha
    vegetation_plot: 0.04,       // 400 m² = 0.04 ha
    custom: 0.01
  },
  
  // Bayesian blending reference area
  A_REF: 200000,                 // 200,000 ha reference area
  
  // IPCC Tier 1 Blue Carbon Defaults (kg/m²)
  // Based on IPCC Wetlands Supplement 2013 & 2019 Refinement
  TIER1_DEFAULTS: {
    'High-Marsh': {
      mean: 12.3,                // High productivity salt marsh
      stdDev: 8.5,
      description: 'High productivity salt marsh (IPCC Tier 1)',
      source: 'IPCC 2013 Wetlands Supplement'
    },
    'Low-Marsh': {
      mean: 8.5,                 // Lower productivity marsh
      stdDev: 6.2,
      description: 'Low productivity salt marsh (IPCC Tier 1)',
      source: 'IPCC 2013 Wetlands Supplement'
    },
    'Seagrass-Dense': {
      mean: 10.5,                // Dense seagrass meadows
      stdDev: 7.8,
      description: 'Dense seagrass meadow (IPCC Tier 1)',
      source: 'IPCC 2019 Refinement'
    },
    'Seagrass-Sparse': {
      mean: 6.2,                 // Sparse seagrass
      stdDev: 4.5,
      description: 'Sparse seagrass meadow (IPCC Tier 1)',
      source: 'IPCC 2019 Refinement'
    },
    'Generic-Blue-Carbon': {
      mean: 10.0,                // Generic coastal wetland
      stdDev: 7.5,
      description: 'Generic blue carbon ecosystem (IPCC Tier 1)',
      source: 'IPCC 2013 Wetlands Supplement'
    }
  },
  
  // Support for custom Tier 2 values
  TIER2_MODE: false
};

var STYLES = {
  TITLE: {fontSize: '28px', fontWeight: 'bold', color: '#004d7a'},
  SUBTITLE: {fontSize: '18px', fontWeight: '500', color: '#333333'},
  PARAGRAPH: {fontSize: '14px', color: '#555555'},
  HEADER: {fontSize: '16px', fontWeight: 'bold', margin: '16px 0 4px 8px'},
  SUBHEADER: {fontSize: '14px', fontWeight: 'bold', margin: '10px 0 0 0'},
  PANEL: {width: '440px', border: '1px solid #cccccc'},
  INSTRUCTION: {fontSize: '12px', color: '#999999', margin: '4px 8px'},
  INFO: {fontSize: '12px', color: '#1565C0', margin: '4px 8px'},
  SUCCESS: {fontSize: '13px', color: '#00796B', fontWeight: 'bold', margin: '8px'},
  ERROR: {fontSize: '13px', color: '#D32F2F', fontWeight: 'bold', margin: '8px'},
  WARNING: {fontSize: '13px', color: '#F57C00', fontStyle: 'italic', margin: '8px'}
};

// Color palette for strata visualization
var COLOR_PALETTE = [
  '#E41A1C', '#377EB8', '#4DAF4A', '#984EA3',
  '#FF7F00', '#FFFF33', '#A65628', '#F781BF',
  '#8DD3C7', '#FFFFB3', '#BEBADA', '#FB8072',
  '#80B1D3', '#FDB462', '#B3DE69', '#FCCDE5'
];

// =================================================================================
// === 2. STATE MANAGEMENT =========================================================
// =================================================================================

var AppState = {
  // Stratification
  stratificationMode: null,      // 'draw' or 'asset'
  featureList: [],               // For manual drawing
  stratumCollection: null,       // ee.FeatureCollection
  standardizedStrata: null,      // Standardized strata objects (client-side)
  selectedStrata: {},            // For asset mode
  
  // Sampling
  allocationPlan: null,          // Sample allocation per stratum
  currentPoints: null,           // Generated sample points
  
  // Carbon priors
  tierMode: 'tier1',             // 'tier1' or 'tier2'
  carbonPriors: {},              // Stratum-specific priors
  
  // Processing
  isProcessing: false,
  isDrawing: false,              // Track if currently in drawing mode
  
  reset: function() {
    this.stratificationMode = null;
    this.featureList = [];
    this.stratumCollection = null;
    this.standardizedStrata = null;
    this.selectedStrata = {};
    this.allocationPlan = null;
    this.currentPoints = null;
    this.tierMode = 'tier1';
    this.carbonPriors = {};
    this.isProcessing = false;
    this.isDrawing = false;
  },
  
  getActiveStrata: function() {
    if (this.stratificationMode === 'draw') {
      return this.stratumCollection;
    } else if (this.stratificationMode === 'asset') {
      var selectedKeys = Object.keys(this.selectedStrata);
      if (selectedKeys.length === 0) return null;
      return this.stratumCollection.filter(ee.Filter.inList('stratum_name', selectedKeys));
    }
    return null;
  }
};

// =================================================================================
// === 3. UTILITY FUNCTIONS ========================================================
// =================================================================================

var Utils = {
  
  formatNumber: function(num, decimals) {
    decimals = decimals !== undefined ? decimals : 2;
    if (num === null || num === undefined || isNaN(num)) return 'N/A';
    return num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  },
  
  validateNumber: function(value, min, max, name) {
    var num = parseFloat(value);
    if (isNaN(num) || num < min || num > max) {
      return {valid: false, message: name + ' must be between ' + min + ' and ' + max};
    }
    return {valid: true, value: num};
  },
  
  /**
   * Calculate Z-score using polynomial approximation
   */
  calculateZScore: function(confidencePercent) {
    var alpha = 1 - (confidencePercent / 100);
    return 2.41 + (-10.9 * alpha) + (37.7 * Math.pow(alpha, 2)) - (57.9 * Math.pow(alpha, 3));
  },
  
  /**
   * Get Student's t-value for given confidence level and degrees of freedom
   * Implements exact lookup tables for df <= 30, Z-approximation for df > 30
   */
  getTValue: function(confidencePercent, df) {
    var alpha = 1 - (confidencePercent / 100);
    var is95 = Math.abs(alpha - 0.05) < 0.01;
    var is90 = Math.abs(alpha - 0.10) < 0.01;
    var is85 = Math.abs(alpha - 0.15) < 0.01;
    var is80 = Math.abs(alpha - 0.20) < 0.01;
    
    // For large samples or non-standard confidence, use Z-score
    if (df > 30 || (!is95 && !is90 && !is85 && !is80)) {
      return this.calculateZScore(confidencePercent);
    }
    
    // Lookup tables for common confidence levels
    var t95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
               2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
               2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
    
    var t90 = [0, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812,
               1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729, 1.725,
               1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
    
    var t85 = [0, 4.165, 2.282, 1.924, 1.778, 1.699, 1.650, 1.617, 1.593, 1.574, 1.559,
               1.548, 1.538, 1.530, 1.523, 1.517, 1.512, 1.508, 1.504, 1.500, 1.497,
               1.494, 1.492, 1.489, 1.487, 1.485, 1.483, 1.481, 1.480, 1.478, 1.477];
    
    var t80 = [0, 3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372,
               1.363, 1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325,
               1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313, 1.311, 1.310];
    
    var index = Math.max(1, Math.min(30, Math.floor(df)));
    
    if (is95) return t95[index];
    if (is90) return t90[index];
    if (is85) return t85[index];
    if (is80) return t80[index];
    
    return this.calculateZScore(confidencePercent);
  },
  
  /**
   * Apply Bayesian blending using proper mixture variance formula
   */
  applyBayesianBlending: function(measuredMean, measuredStdDev, areaHa, defaultMean, defaultStdDev) {
    var w = areaHa / (areaHa + CONFIG.A_REF);
    var blendedMean = (w * measuredMean) + ((1 - w) * defaultMean);
    
    var measuredVar = Math.pow(measuredStdDev, 2);
    var defaultVar = Math.pow(defaultStdDev, 2);
    var meanDiff = measuredMean - defaultMean;
    
    var blendedVariance = (Math.pow(w, 2) * measuredVar) + 
                          (Math.pow(1 - w, 2) * defaultVar) + 
                          (w * (1 - w) * Math.pow(meanDiff, 2));
    
    var blendedStdDev = Math.sqrt(blendedVariance);
    
    return {
      mean: blendedMean,
      stdDev: blendedStdDev,
      weight: w
    };
  }
};

// =================================================================================
// === 4. STRATA MANAGER ===========================================================
// =================================================================================

var StrataManager = {
  
  /**
   * Standardize strata from any source into common format
   */
  standardizeStrata: function(strataArray) {
    return strataArray.map(function(s) {
      return {
        name: s.stratum_name || s.name,
        areaHa: s.area / 10000,
        areaSqM: s.area,
        stdDev: s.stdDev || 0,
        mean: s.mean || 0,
        plotSizeHa: s.plotSizeHa || CONFIG.PLOT_SIZES.sediment_core,
        carbonPriorSource: s.carbonPriorSource || 'tier1',
        featureCount: s.featureCount || 1
      };
    });
  },
  
  /**
   * Calculate areas for all strata
   */
  calculateStrataAreas: function(featureCollection, callback) {
    var withArea = featureCollection.map(function(f) {
      return f.set('area_m2', f.geometry().area({maxError: CONFIG.MAX_ERROR}));
    });
    
    var stats = withArea.reduceColumns({
      reducer: ee.Reducer.sum().group({
        groupField: 1,
        groupName: 'stratum_name'
      }),
      selectors: ['area_m2', 'stratum_name']
    });
    
    stats.evaluate(function(result, error) {
      if (error) {
        callback(null, error);
        return;
      }
      
      var strataInfo = result.groups.map(function(g) {
        return {
          stratum_name: g.stratum_name,
          area: g.sum,
          stdDev: 0,
          mean: 0
        };
      });
      
      callback(strataInfo, null);
    });
  },
  
  /**
   * Apply carbon priors to strata
   */
  applyCarbonPriors: function(strataInfo, tierMode) {
    return strataInfo.map(function(s) {
      var stratumName = s.name || s.stratum_name;
      
      // Check if user provided custom values
      if (AppState.carbonPriors[stratumName]) {
        var custom = AppState.carbonPriors[stratumName];
        s.mean = custom.mean;
        s.stdDev = custom.stdDev;
        s.carbonPriorSource = 'tier2_custom';
        return s;
      }
      
      // Try to match with Tier 1 defaults
      if (CONFIG.TIER1_DEFAULTS[stratumName]) {
        var defaults = CONFIG.TIER1_DEFAULTS[stratumName];
        s.mean = defaults.mean;
        s.stdDev = defaults.stdDev;
        s.carbonPriorSource = 'tier1';
        s.priorDescription = defaults.description;
        return s;
      }
      
      // Fallback to generic blue carbon
      var generic = CONFIG.TIER1_DEFAULTS['Generic-Blue-Carbon'];
      s.mean = generic.mean;
      s.stdDev = generic.stdDev;
      s.carbonPriorSource = 'tier1_generic';
      s.priorDescription = generic.description;
      
      return s;
    });
  }
};

// =================================================================================
// === 5. STRATIFIED SAMPLER =======================================================
// =================================================================================

var StratifiedSampler = {
  
  /**
   * UNFCCC AR-AM-Tool-03 Stratified Sample Size Calculation
   * 
   * Formula:
   * n_total = (Σ N_i * σ_i)² / ((N * E / t_val)² + Σ N_i * σ_i²)
   * 
   * Then allocate proportionally by area:
   * n_i = n_total * (Area_i / Total_Area)
   */
  calculateStratifiedSampleSize: function(strataInfo, confidence, marginOfError, plotSizeHa) {
    var L = strataInfo.length;
    
    // Calculate population sizes (N_i) for each stratum
    var totalAreaHa = 0;
    strataInfo.forEach(function(s) {
      s.N_i = s.areaHa / plotSizeHa;
      totalAreaHa += s.areaHa;
    });
    
    var N = totalAreaHa / plotSizeHa; // Total population
    
    // Iterative calculation with t-distribution
    var n_prev = N; // Start with population size
    var n_final = 0;
    var iterations = 0;
    var maxIterations = 20;
    var t_val;
    var convergenceLog = [];
    
    // Calculate average mean for margin of error
    var weightedMean = 0;
    strataInfo.forEach(function(s) {
      weightedMean += (s.areaHa / totalAreaHa) * s.mean;
    });
    
    var E = weightedMean * (marginOfError / 100); // Absolute error
    
    while (iterations < maxIterations) {
      // Degrees of freedom = n - L (sample size - number of strata)
      var df = Math.max(1, n_prev - L);
      t_val = Utils.getTValue(confidence, df);
      
      // Calculate sums
      var sum_Ni_sigma = 0;
      var sum_Ni_sigma_squared = 0;
      
      strataInfo.forEach(function(s) {
        sum_Ni_sigma += s.N_i * s.stdDev;
        sum_Ni_sigma_squared += s.N_i * Math.pow(s.stdDev, 2);
      });
      
      // UNFCCC stratified formula
      var numerator = Math.pow(sum_Ni_sigma, 2);
      var denominator = Math.pow((N * E) / t_val, 2) + sum_Ni_sigma_squared;
      
      n_final = numerator / denominator;
      
      convergenceLog.push({
        iteration: iterations + 1,
        df: df,
        t_value: t_val,
        n_estimate: n_final
      });
      
      // Check convergence
      if (Math.abs(n_final - n_prev) < 0.1) {
        break;
      }
      
      n_prev = n_final;
      iterations++;
    }
    
    // Round up to ensure adequate sample
    var n_total = Math.ceil(n_final);
    
    // Ensure minimum total samples
    n_total = Math.max(CONFIG.MIN_TOTAL_SAMPLES, n_total);
    
    // UNFCCC Stratified Allocation (Proportional to Area)
    // Allocate samples proportional to stratum area
    strataInfo.forEach(function(s) {
      var proportion = s.areaHa / totalAreaHa;
      var exact = n_total * proportion;
      s.points = Math.max(CONFIG.MIN_SAMPLES_PER_STRATUM, Math.floor(exact));
      s._remainder = exact - Math.floor(exact);
    });
    
    // Adjust to match exact total (largest remainder method)
    var assigned = strataInfo.reduce(function(sum, s) { return sum + s.points; }, 0);
    var diff = n_total - assigned;
    
    if (diff !== 0) {
      strataInfo.sort(function(a, b) { 
        return diff > 0 ? b._remainder - a._remainder : a._remainder - b._remainder; 
      });
      
      for (var i = 0; i < Math.abs(diff); i++) {
        if (diff > 0) {
          strataInfo[i].points++;
        } else if (strataInfo[i].points > CONFIG.MIN_SAMPLES_PER_STRATUM) {
          strataInfo[i].points--;
        }
      }
    }
    
    return {
      n_total: n_total,
      strata: strataInfo,
      t_value: t_val,
      df: Math.max(1, n_total - L),
      iterations: iterations + 1,
      convergenceLog: convergenceLog,
      E: E,
      weightedMean: weightedMean
    };
  },
  
  /**
   * Generate stratified random points
   */
  generateStratifiedRandomPoints: function(stratumCollection, allocationPlan, callback) {
    var strataWithPoints = allocationPlan.filter(function(s) { return s.points > 0; });
    
    if (strataWithPoints.length === 0) {
      callback(null, 'No strata have allocated points');
      return;
    }
    
    print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    print('🎲 Generating Stratified Random Sample Points');
    print('Number of strata:', strataWithPoints.length);
    
    var allPoints = [];
    var processedCount = 0;
    
    strataWithPoints.forEach(function(stratumPlan) {
      var stratumName = stratumPlan.name;
      var numPoints = stratumPlan.points;
      
      print('  • ' + stratumName + ': ' + numPoints + ' points');
      
      // Get features for this stratum
      var stratumFeatures = stratumCollection.filter(
        ee.Filter.eq('stratum_name', stratumName)
      );
      
      // Union all features in stratum
      var stratumGeometry = stratumFeatures.union().geometry();
      
      // Optional: buffer inward to avoid edge effects
      var bufferedGeometry = stratumGeometry.buffer(-CONFIG.RANDOM_BUFFER_M, CONFIG.MAX_ERROR);
      
      // Check if buffer made geometry too small
      bufferedGeometry.area({maxError: CONFIG.MAX_ERROR}).evaluate(function(bufArea) {
        var finalGeometry = (bufArea && bufArea > 1000) ? bufferedGeometry : stratumGeometry;
        
        // Generate random points
        var points = ee.FeatureCollection.randomPoints({
          region: finalGeometry,
          points: numPoints,
          seed: CONFIG.DEFAULT_SEED + processedCount,
          maxError: CONFIG.MAX_ERROR
        });
        
        // Add metadata
        var pointsWithMeta = points.map(function(p) {
          var coords = p.geometry().coordinates();
          return p.set({
            'stratum_name': stratumName,
            'point_id': ee.String('PT_').cat(ee.Number(processedCount).format('%04d')),
            'sampling_type': 'stratified_random',
            'lon': coords.get(0),
            'lat': coords.get(1)
          });
        });
        
        allPoints.push(pointsWithMeta);
        processedCount++;
        
        // When all strata processed
        if (processedCount === strataWithPoints.length) {
          var combinedPoints = ee.FeatureCollection(allPoints).flatten();
          
          // Add sequential IDs
          var pointsList = combinedPoints.toList(combinedPoints.size());
          pointsList.size().evaluate(function(listSize) {
            if (!listSize || listSize <= 0) {
              callback(ee.FeatureCollection([]), null);
              return;
            }

            var sequence = ee.List.sequence(0, listSize - 1);

            var finalPoints = ee.FeatureCollection(
              sequence.map(function(idx) {
                var pt = ee.Feature(pointsList.get(idx));
                return pt.set({
                  'point_id': ee.String('BC_').cat(ee.Number(idx).add(1).format('%05d')),
                  'date_generated': ee.Date(Date.now()).format('YYYY-MM-dd')
                });
              })
            );

            print('✓ Total points generated:', listSize);
            print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            callback(finalPoints, null);
          });
        }
      });
    });
  }
};

// =================================================================================
// === 6. USER INTERFACE ===========================================================
// =================================================================================

ui.root.clear();
var map = ui.Map();
var panel = ui.Panel({style: STYLES.PANEL});
var splitPanel = ui.SplitPanel(panel, map, 'horizontal', false);
ui.root.add(splitPanel);
map.setCenter(-95, 55, 4);

// --- Header ---
panel.add(ui.Label('Blue Carbon Stratified Sampling Tool', STYLES.TITLE));
//panel.add(ui.Label('UNFCCC AR-AM-Tool-03 Methodology', STYLES.SUBTITLE));
panel.add(ui.Label(
  'Munual-stratified random sampling design for coastal blue carbon ecosystems',
  STYLES.PARAGRAPH
));
panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 1: DEFINE STRATA =======================================================
// =================================================================================

panel.add(ui.Label('Step 1: Define Blue Carbon Ecosystem Strata', STYLES.HEADER));

var stratificationModeSelect = ui.Select({
  items: ['Draw Strata Manually', 'Upload Strata Asset'],
  placeholder: 'Select stratification method...',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: handleStratificationModeChange
});
panel.add(stratificationModeSelect);

// --- Manual Drawing Panel ---
var drawingPanel = ui.Panel({style: {shown: false}});
var stratumNameBox = ui.Textbox({
  placeholder: 'e.g., High-Marsh, Seagrass-Dense',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

// Tier 1 ecosystem selector
var tier1EcosystemSelect = ui.Select({
  items: Object.keys(CONFIG.TIER1_DEFAULTS),
  placeholder: 'Use IPCC Tier 1 default...',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    if (value) {
      stratumNameBox.setValue(value);
    }
  }
});

var drawButton = ui.Button({
  label: '🖊️ Start Drawing Polygon',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: startDrawing
});

var finishDrawingButton = ui.Button({
  label: '✓ Finish & Add This Stratum',
  style: {stretch: 'horizontal', margin: '8px', backgroundColor: '#00796B'},
  disabled: true,
  onClick: finishDrawing
});

var drawingStatusLabel = ui.Label('', {fontSize: '12px', color: '#666', margin: '4px 8px'});
var stratumListLabel = ui.Label('Defined Strata: None', {
  margin: '8px', fontSize: '12px', whiteSpace: 'pre-wrap'
});

drawingPanel.add(ui.Label('Option A: Select IPCC Tier 1 Ecosystem:', STYLES.INSTRUCTION));
drawingPanel.add(tier1EcosystemSelect);
drawingPanel.add(ui.Label('Option B: Enter custom stratum name:', STYLES.INSTRUCTION));
drawingPanel.add(stratumNameBox);
drawingPanel.add(ui.Label('3. Draw polygon on map:', STYLES.INSTRUCTION));
drawingPanel.add(drawButton);
drawingPanel.add(ui.Label('4. Click to finish when done drawing:', STYLES.INSTRUCTION));
drawingPanel.add(finishDrawingButton);
drawingPanel.add(drawingStatusLabel);
drawingPanel.add(ui.Label('', {height: '8px'})); // Spacer
drawingPanel.add(stratumListLabel);
panel.add(drawingPanel);

// --- Asset Upload Panel ---
var assetPanel = ui.Panel({style: {shown: false}});
var assetPathBox = ui.Textbox({
  placeholder: 'e.g., users/yourname/blue_carbon_strata',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

var stratumFieldBox = ui.Textbox({
  placeholder: 'Attribute field for stratification',
  value: 'ecosystem_type',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

var loadAssetButton = ui.Button({
  label: '📁 Load Strata from Asset',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: loadStrataAsset
});

var assetStatusLabel = ui.Label('', {fontSize: '12px', margin: '4px 8px'});
var strataCheckboxPanel = ui.Panel({style: {margin: '0 8px', maxHeight: '200px'}});

assetPanel.add(ui.Label('GEE Asset Path:', STYLES.INSTRUCTION));
assetPanel.add(assetPathBox);
assetPanel.add(ui.Label('Stratification Field Name:', STYLES.INSTRUCTION));
assetPanel.add(stratumFieldBox);
assetPanel.add(loadAssetButton);
assetPanel.add(assetStatusLabel);
assetPanel.add(ui.Label('Select Strata to Include:', STYLES.SUBHEADER));
assetPanel.add(strataCheckboxPanel);
panel.add(assetPanel);

var finalizeStrataButton = ui.Button({
  label: '✓ Finalize Strata & Calculate Areas',
  style: {stretch: 'horizontal', margin: '8px'},
  disabled: true,
  onClick: finalizeStrata
});
panel.add(finalizeStrataButton);

var strataResultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(strataResultsPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 2: CARBON PRIORS =======================================================
// =================================================================================

panel.add(ui.Label('Step 2: Configure Carbon Priors', STYLES.HEADER));

var tierModeSelect = ui.Select({
  items: ['IPCC Tier 1 Defaults', 'Tier 2 Custom Values'],
  value: 'IPCC Tier 1 Defaults',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    AppState.tierMode = value === 'IPCC Tier 1 Defaults' ? 'tier1' : 'tier2';
    tier2InputPanel.style().set('shown', AppState.tierMode === 'tier2');
  }
});

panel.add(ui.Label('Carbon Prior Mode:', STYLES.INSTRUCTION));
panel.add(tierModeSelect);

var tier2InputPanel = ui.Panel({style: {shown: false, margin: '0 8px'}});

// Add instructions for Tier 2
tier2InputPanel.add(ui.Label(
  'Enter custom carbon stock values for each stratum after finalization:',
  {fontSize: '11px', color: '#666', margin: '4px 0', fontStyle: 'italic'}
));

// Container for dynamic stratum input fields (will be populated after finalization)
var tier2StratumInputsPanel = ui.Panel({style: {margin: '8px 0'}});
tier2InputPanel.add(tier2StratumInputsPanel);

panel.add(tier2InputPanel);

var priorsSummaryPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(priorsSummaryPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 3: SAMPLE SIZE =========================================================
// =================================================================================

panel.add(ui.Label('Step 3: Calculate Stratified Sample Size', STYLES.HEADER));

var confidenceBox = ui.Textbox({
  placeholder: '80-99',
  value: CONFIG.DEFAULT_CONFIDENCE.toString(),
  style: {width: '80px', margin: '0 8px'}
});

var marginOfErrorBox = ui.Textbox({
  placeholder: '1-50',
  value: CONFIG.DEFAULT_MARGIN_OF_ERROR.toString(),
  style: {width: '80px', margin: '0 8px'}
});

panel.add(ui.Panel([
  ui.Label('Confidence Level (%):', {width: '140px'}),
  confidenceBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));

panel.add(ui.Panel([
  ui.Label('Margin of Error (%):', {width: '140px'}),
  marginOfErrorBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));

var plotTypeSelect = ui.Select({
  items: ['Sediment Core (100 m²)', 'Composite Plot (250 m²)', 
          'Vegetation Plot (400 m²)', 'Custom'],
  value: 'Sediment Core (100 m²)',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    customPlotSizeBox.style().set('shown', value === 'Custom');
  }
});

var customPlotSizeBox = ui.Textbox({
  placeholder: 'Enter plot size in ha (e.g., 0.01)',
  style: {stretch: 'horizontal', margin: '0 8px', shown: false}
});

panel.add(ui.Label('Plot Type:', STYLES.INSTRUCTION));
panel.add(plotTypeSelect);
panel.add(customPlotSizeBox);

var calculateSampleSizeButton = ui.Button({
  label: '📊 Calculate Stratified Sample Size',
  style: {stretch: 'horizontal', margin: '8px'},
  disabled: true,
  onClick: calculateSampleSize
});
panel.add(calculateSampleSizeButton);

var sampleSizeResultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(sampleSizeResultsPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 4: GENERATE POINTS =====================================================
// =================================================================================

panel.add(ui.Label('Step 4: Generate Stratified Random Points', STYLES.HEADER));

var generatePointsButton = ui.Button({
  label: '🎲 Generate Stratified Random Sample',
  style: {stretch: 'horizontal', margin: '8px'},
  disabled: true,
  onClick: generatePoints
});
panel.add(generatePointsButton);

var pointsResultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(pointsResultsPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 5: EXPORT ==============================================================
// =================================================================================

panel.add(ui.Label('Step 5: Export Sampling Design', STYLES.HEADER));

var exportFormatSelect = ui.Select({
  items: ['CSV', 'GeoJSON', 'KML', 'SHP'],
  value: 'CSV',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

panel.add(ui.Label('Export Format:', STYLES.INSTRUCTION));
panel.add(exportFormatSelect);

var exportPointsButton = ui.Button({
  label: '⬇️ Export Sample Points',
  style: {stretch: 'horizontal', margin: '4px 8px'},
  disabled: true,
  onClick: exportPoints
});

var exportStrataButton = ui.Button({
  label: '⬇️ Export Strata Polygons',
  style: {stretch: 'horizontal', margin: '4px 8px'},
  disabled: true,
  onClick: exportStrata
});

panel.add(exportPointsButton);
panel.add(exportStrataButton);

var downloadLinksPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(downloadLinksPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// Reset button
panel.add(ui.Button({
  label: '🔄 Reset All',
  style: {stretch: 'horizontal', margin: '20px 8px', backgroundColor: '#f5f5f5'},
  onClick: clearAll
}));

// Footer
panel.add(ui.Label('Developed for Blue Carbon Ecosystem Assessment', {
  fontSize: '10px',
  color: '#999',
  margin: '10px 8px',
  textAlign: 'center'
}));

// =================================================================================
// === 7. CORE WORKFLOW FUNCTIONS ==================================================
// =================================================================================

function handleStratificationModeChange(value) {
  var isDrawing = value === 'Draw Strata Manually';
  drawingPanel.style().set('shown', isDrawing);
  assetPanel.style().set('shown', !isDrawing);
  AppState.stratificationMode = isDrawing ? 'draw' : 'asset';
  
  map.drawingTools().clear();
  map.drawingTools().setShown(isDrawing);
  map.layers().reset();
  
  strataResultsPanel.clear();
  sampleSizeResultsPanel.clear();
  pointsResultsPanel.clear();
  downloadLinksPanel.clear();
  priorsSummaryPanel.clear();
  
  if (isDrawing) {
    AppState.featureList = [];
    updateStratumListUI();
    // Reset drawing buttons
    drawButton.setDisabled(false);
    finishDrawingButton.setDisabled(true);
  }
  
  finalizeStrataButton.setDisabled(true);
  calculateSampleSizeButton.setDisabled(true);
  generatePointsButton.setDisabled(true);
  exportPointsButton.setDisabled(true);
  exportStrataButton.setDisabled(true);
}

function updateStratumListUI() {
  if (AppState.featureList.length === 0) {
    stratumListLabel.setValue('Defined Strata: None');
    finalizeStrataButton.setDisabled(true);
    return;
  }
  
  var counts = {};
  AppState.featureList.forEach(function(f) {
    var name = f.get('stratum_name').getInfo();
    counts[name] = (counts[name] || 0) + 1;
  });
  
  var summary = Object.keys(counts).map(function(n) {
    return '• ' + n + ' (' + counts[n] + ' polygon' + (counts[n] > 1 ? 's' : '') + ')';
  }).join('\n');
  
  stratumListLabel.setValue('Defined Strata:\n' + summary);
  finalizeStrataButton.setDisabled(false);
}

function startDrawing() {
  var name = stratumNameBox.getValue().trim();
  if (!name) {
    alert('Please enter a stratum name before drawing.');
    return;
  }
  
  AppState.isDrawing = true;
  drawingStatusLabel.setValue('🎨 Drawing active: Click on map to place vertices. Double-click to complete shape.');
  drawingStatusLabel.style().set('color', '#1565C0');
  
  // Clear any incomplete drawings
  var layers = map.drawingTools().layers();
  if (layers.length() > 0) {
    layers.get(0).geometries().reset();
  }
  
  // Enable finish button, disable start button
  drawButton.setDisabled(true);
  finishDrawingButton.setDisabled(false);
  
  map.drawingTools().setShape('polygon');
  map.drawingTools().draw();
}

function finishDrawing() {
  var name = stratumNameBox.getValue().trim();
  if (!name) {
    alert('Error: No stratum name specified.');
    AppState.isDrawing = false;
    finishDrawingButton.setDisabled(true);
    drawButton.setDisabled(false);
    return;
  }
  
  // Get the drawn geometry from the drawing tools
  var layers = map.drawingTools().layers();
  if (layers.length() === 0 || layers.get(0).geometries().length() === 0) {
    alert('No geometry drawn. Please draw a polygon first.');
    return;
  }
  
  var geometry = layers.get(0).geometries().get(0);
  
  if (!geometry) {
    alert('Invalid geometry. Please try drawing again.');
    return;
  }
  
  // Add feature to list
  AppState.featureList.push(ee.Feature(geometry, {'stratum_name': name}));
  
  // Reset drawing tools
  map.drawingTools().setShape(null);
  layers.get(0).geometries().reset();
  
  // Visual feedback
  drawingStatusLabel.setValue('✓ Stratum "' + name + '" added successfully!');
  drawingStatusLabel.style().set('color', '#00796B');
  
  // Reset UI
  stratumNameBox.setValue('');
  tier1EcosystemSelect.setValue(null);
  AppState.isDrawing = false;
  
  // Re-enable start button, disable finish button
  drawButton.setDisabled(false);
  finishDrawingButton.setDisabled(true);
  
  updateStratumListUI();
  
  // Add visual layer to map
  var colorIndex = (AppState.featureList.length - 1) % COLOR_PALETTE.length;
  var color = COLOR_PALETTE[colorIndex];
  map.addLayer(
    ee.FeatureCollection([ee.Feature(geometry)]).style({
      color: color, 
      fillColor: color + '80', 
      width: 2
    }),
    {},
    'Stratum: ' + name
  );
  
  // Clear status message after 3 seconds (GEE UI runtime-safe)
  ui.util.setTimeout(function() {
    drawingStatusLabel.setValue('');
  }, 3000);
  
  print('✓ Added stratum "' + name + '" with ' + 
        '1 polygon (total features: ' + AppState.featureList.length + ')');
}

function loadStrataAsset() {
  var path = assetPathBox.getValue().trim();
  var field = stratumFieldBox.getValue().trim();
  
  if (!path || !field) {
    alert('Please provide both asset path and field name.');
    return;
  }
  
  assetStatusLabel.setValue('⏳ Loading asset...');
  assetStatusLabel.style().set('color', '#1565C0');
  map.layers().reset();
  strataCheckboxPanel.clear();
  
  try {
    var fc = ee.FeatureCollection(path);
    
    var renamedFC = fc.map(function(f) {
      return f.set('stratum_name', f.get(field));
    });
    
    renamedFC.aggregate_array('stratum_name').distinct().evaluate(function(ids, error) {
      if (error) {
        assetStatusLabel.setValue('❌ Error: ' + error);
        assetStatusLabel.style().set('color', '#D32F2F');
        return;
      }
      
      if (!ids || ids.length === 0) {
        assetStatusLabel.setValue('❌ No features found in asset');
        assetStatusLabel.style().set('color', '#D32F2F');
        return;
      }
      
      AppState.stratumCollection = renamedFC;
      AppState.selectedStrata = {};
      
      ids.forEach(function(id, index) {
        AppState.selectedStrata[id] = true;
        
        var color = COLOR_PALETTE[index % COLOR_PALETTE.length];
        var checkbox = ui.Checkbox({
          label: String(id),
          value: true,
          onChange: function(checked) {
            if (checked) {
              AppState.selectedStrata[id] = true;
            } else {
              delete AppState.selectedStrata[id];
            }
            var hasSelected = Object.keys(AppState.selectedStrata).length > 0;
            finalizeStrataButton.setDisabled(!hasSelected);
          },
          style: {color: color}
        });
        strataCheckboxPanel.add(checkbox);
      });
      
      assetStatusLabel.setValue('✓ Loaded ' + ids.length + ' unique strata');
      assetStatusLabel.style().set('color', '#00796B');
      
      map.addLayer(
        renamedFC.style({color: '0000FF', fillColor: '0000FF33', width: 2}),
        {},
        'All Strata'
      );
      map.centerObject(renamedFC, 8);
      finalizeStrataButton.setDisabled(false);
    });
  } catch (e) {
    assetStatusLabel.setValue('❌ Invalid asset path');
    assetStatusLabel.style().set('color', '#D32F2F');
  }
}

function finalizeStrata() {
  if (AppState.isProcessing) return;
  AppState.isProcessing = true;
  
  strataResultsPanel.clear();
  sampleSizeResultsPanel.clear();
  pointsResultsPanel.clear();
  priorsSummaryPanel.clear();
  
  if (AppState.stratificationMode === 'draw') {
    if (AppState.featureList.length === 0) {
      alert('No strata defined. Please draw at least one polygon.');
      AppState.isProcessing = false;
      return;
    }
    AppState.stratumCollection = ee.FeatureCollection(AppState.featureList);
  }
  
  strataResultsPanel.add(ui.Label('⏳ Calculating stratum areas...', STYLES.INFO));
  
  var active = AppState.getActiveStrata();
  
  if (!active) {
    strataResultsPanel.clear();
    strataResultsPanel.add(ui.Label('❌ No strata selected', STYLES.ERROR));
    AppState.isProcessing = false;
    return;
  }
  
  StrataManager.calculateStrataAreas(active, function(strataInfo, error) {
    strataResultsPanel.clear();
    AppState.isProcessing = false;
    
    if (error) {
      strataResultsPanel.add(ui.Label('❌ Error: ' + error, STYLES.ERROR));
      return;
    }
    
    // Standardize strata
    AppState.standardizedStrata = StrataManager.standardizeStrata(strataInfo);
    
    // Apply carbon priors
    AppState.standardizedStrata = StrataManager.applyCarbonPriors(
      AppState.standardizedStrata,
      AppState.tierMode
    );
    
    // Display results
    var totalArea = AppState.standardizedStrata.reduce(function(sum, s) {
      return sum + s.areaHa;
    }, 0);
    
    strataResultsPanel.add(ui.Label('✓ Stratification Complete', STYLES.SUCCESS));
    strataResultsPanel.add(ui.Label(
      'Total Area: ' + Utils.formatNumber(totalArea, 1) + ' ha | ' +
      'Strata: ' + AppState.standardizedStrata.length,
      {fontWeight: 'bold', fontSize: '14px', margin: '8px 0'}
    ));
    
    // Create summary table
    var headerPanel = ui.Panel([
      ui.Label('Stratum', {fontWeight: 'bold', width: '140px'}),
      ui.Label('Area (ha)', {fontWeight: 'bold', width: '90px'}),
      ui.Label('%', {fontWeight: 'bold', width: '50px'}),
      ui.Label('Prior', {fontWeight: 'bold', width: '60px'})
    ], ui.Panel.Layout.flow('horizontal'), {margin: '8px 0 4px 0'});
    strataResultsPanel.add(headerPanel);
    
    AppState.standardizedStrata.forEach(function(s) {
      var pct = (s.areaHa / totalArea * 100).toFixed(1);
      var priorSource = s.carbonPriorSource === 'tier1' ? 'T1' :
                       s.carbonPriorSource === 'tier2_custom' ? 'T2' : 'T1*';
      
      var rowPanel = ui.Panel([
        ui.Label(String(s.name), {width: '140px', fontSize: '11px'}),
        ui.Label(Utils.formatNumber(s.areaHa, 1), {width: '90px', fontSize: '11px'}),
        ui.Label(pct + '%', {width: '50px', fontSize: '11px'}),
        ui.Label(priorSource, {width: '60px', fontSize: '11px'})
      ], ui.Panel.Layout.flow('horizontal'), {margin: '2px 0'});
      strataResultsPanel.add(rowPanel);
    });
    
    // Display carbon priors summary
    displayCarbonPriorsSummary();
    
    // Build Tier 2 input fields (will be shown if user selects Tier 2 mode)
    buildTier2InputFields();
    
    calculateSampleSizeButton.setDisabled(false);
  });
}

function displayCarbonPriorsSummary() {
  priorsSummaryPanel.clear();
  priorsSummaryPanel.add(ui.Label('Carbon Priors Summary', STYLES.SUBHEADER));
  
  AppState.standardizedStrata.forEach(function(s) {
    var panel = ui.Panel({
      style: {
        border: '1px solid #E0E0E0',
        padding: '8px',
        margin: '4px 0',
        backgroundColor: '#F9F9F9'
      }
    });
    
    panel.add(ui.Label(s.name, {fontWeight: 'bold', fontSize: '12px'}));
    panel.add(ui.Label('Mean: ' + Utils.formatNumber(s.mean, 2) + ' kg/m²', {fontSize: '11px'}));
    panel.add(ui.Label('Std Dev: ' + Utils.formatNumber(s.stdDev, 2) + ' kg/m²', {fontSize: '11px'}));
    panel.add(ui.Label('CV: ' + Utils.formatNumber((s.stdDev / s.mean) * 100, 1) + '%', {fontSize: '11px'}));
    
    if (s.priorDescription) {
      panel.add(ui.Label(s.priorDescription, {fontSize: '10px', color: '#666', fontStyle: 'italic'}));
    }
    
    priorsSummaryPanel.add(panel);
  });
  
  priorsSummaryPanel.add(ui.Label(
    '► T1 = IPCC Tier 1, T2 = Tier 2 Custom, T1* = Tier 1 Generic Fallback',
    STYLES.INFO
  ));
}

/**
 * Builds Tier 2 custom input fields for each stratum
 */
function buildTier2InputFields() {
  tier2StratumInputsPanel.clear();
  
  if (!AppState.standardizedStrata || AppState.standardizedStrata.length === 0) {
    tier2StratumInputsPanel.add(ui.Label(
      'Please finalize strata first to enable custom inputs',
      {fontSize: '11px', color: '#999', fontStyle: 'italic', margin: '8px 0'}
    ));
    return;
  }
  
  tier2StratumInputsPanel.add(ui.Label(
    'Enter custom values for each stratum (leave blank to use defaults):',
    {fontSize: '12px', fontWeight: 'bold', margin: '8px 0 4px 0'}
  ));
  
  AppState.standardizedStrata.forEach(function(s) {
    var stratumPanel = ui.Panel({
      style: {
        border: '1px solid #E0E0E0',
        padding: '8px',
        margin: '4px 0',
        backgroundColor: '#FAFAFA'
      }
    });
    
    stratumPanel.add(ui.Label(s.name, {
      fontWeight: 'bold',
      fontSize: '12px',
      margin: '0 0 4px 0'
    }));
    
    var meanBox = ui.Textbox({
      placeholder: 'Mean (kg/m²) - default: ' + s.mean.toFixed(2),
      style: {stretch: 'horizontal', margin: '2px 0'}
    });
    
    var stdDevBox = ui.Textbox({
      placeholder: 'Std Dev (kg/m²) - default: ' + s.stdDev.toFixed(2),
      style: {stretch: 'horizontal', margin: '2px 0'}
    });
    
    var applyButton = ui.Button({
      label: 'Apply to ' + s.name,
      style: {stretch: 'horizontal', margin: '4px 0', fontSize: '11px'},
      onClick: function() {
        var meanVal = meanBox.getValue();
        var stdVal = stdDevBox.getValue();
        
        if (meanVal && stdVal) {
          var meanNum = Utils.validateNumber(meanVal, 0, 100, 'Mean carbon');
          var stdNum = Utils.validateNumber(stdVal, 0, 100, 'Std Dev');
          
          if (meanNum.valid && stdNum.valid) {
            AppState.carbonPriors[s.name] = {
              mean: meanNum.value,
              stdDev: stdNum.value
            };
            
            // Update the stratum in standardizedStrata
            var stratum = AppState.standardizedStrata.find(function(st) {
              return st.name === s.name;
            });
            if (stratum) {
              stratum.mean = meanNum.value;
              stratum.stdDev = stdNum.value;
              stratum.carbonPriorSource = 'tier2_custom';
            }
            
            displayCarbonPriorsSummary();
            
            stratumPanel.add(ui.Label('✓ Custom values applied', {
              fontSize: '10px',
              color: '#00796B',
              margin: '4px 0'
            }));
            
            print('✓ Tier 2 custom values applied for ' + s.name + 
                  ': mean=' + meanNum.value + ', stdDev=' + stdNum.value);
          } else {
            alert(!meanNum.valid ? meanNum.message : stdNum.message);
          }
        } else {
          alert('Please enter both mean and standard deviation values');
        }
      }
    });
    
    stratumPanel.add(ui.Label('Mean Carbon Stock:', {fontSize: '11px', margin: '4px 0 2px 0'}));
    stratumPanel.add(meanBox);
    stratumPanel.add(ui.Label('Standard Deviation:', {fontSize: '11px', margin: '4px 0 2px 0'}));
    stratumPanel.add(stdDevBox);
    stratumPanel.add(applyButton);
    
    tier2StratumInputsPanel.add(stratumPanel);
  });
  
  tier2StratumInputsPanel.add(ui.Label(
    'Note: Custom values will be used in sample size calculations',
    {fontSize: '10px', color: '#666', fontStyle: 'italic', margin: '8px 0'}
  ));
}

function calculateSampleSize() {
  if (AppState.isProcessing) return;
  AppState.isProcessing = true;
  
  sampleSizeResultsPanel.clear();
  
  if (!AppState.standardizedStrata || AppState.standardizedStrata.length === 0) {
    sampleSizeResultsPanel.add(ui.Label('❌ Please finalize strata first', STYLES.ERROR));
    AppState.isProcessing = false;
    return;
  }
  
  // Validate inputs
  var confVal = Utils.validateNumber(confidenceBox.getValue(), 80, 99.9, 'Confidence');
  var moeVal = Utils.validateNumber(marginOfErrorBox.getValue(), 1, 50, 'Margin of error');
  
  if (!confVal.valid || !moeVal.valid) {
    alert(!confVal.valid ? confVal.message : moeVal.message);
    AppState.isProcessing = false;
    return;
  }
  
  // Get plot size
  var plotType = plotTypeSelect.getValue();
  var plotSizeHa;
  
  if (!plotType) {
    alert('Please select a plot type');
    AppState.isProcessing = false;
    return;
  }
  
  if (plotType === 'Custom') {
    var customVal = Utils.validateNumber(customPlotSizeBox.getValue(), 0.001, 1, 'Plot size');
    if (!customVal.valid) {
      alert(customVal.message);
      AppState.isProcessing = false;
      return;
    }
    plotSizeHa = customVal.value;
  } else if (plotType.indexOf('Sediment Core') >= 0) {
    plotSizeHa = CONFIG.PLOT_SIZES.sediment_core;
  } else if (plotType.indexOf('Composite') >= 0) {
    plotSizeHa = CONFIG.PLOT_SIZES.composite_plot;
  } else if (plotType.indexOf('Vegetation') >= 0) {
    plotSizeHa = CONFIG.PLOT_SIZES.vegetation_plot;
  } else {
    // Fallback
    plotSizeHa = CONFIG.PLOT_SIZES.sediment_core;
  }
  
  sampleSizeResultsPanel.add(ui.Label('⏳ Calculating stratified sample size...', STYLES.INFO));
  
  // Deep copy strata for calculation
  var strataForCalc = AppState.standardizedStrata.map(function(s) {
    return {
      name: s.name,
      areaHa: s.areaHa,
      mean: s.mean,
      stdDev: s.stdDev
    };
  });
  
  // Calculate sample size
  var result = StratifiedSampler.calculateStratifiedSampleSize(
    strataForCalc,
    confVal.value,
    moeVal.value,
    plotSizeHa
  );
  
  AppState.allocationPlan = result.strata;
  AppState.isProcessing = false;
  
  // Display results
  sampleSizeResultsPanel.clear();
  sampleSizeResultsPanel.add(ui.Label('✓ Stratified Sample Size Calculated', STYLES.SUCCESS));
  
  var summaryPanel = ui.Panel({
    style: {
      border: '2px solid #004d7a',
      padding: '12px',
      margin: '8px 0',
      backgroundColor: '#E3F2FD'
    }
  });
  
  summaryPanel.add(ui.Label('Total Sample Size: ' + result.n_total + ' plots', {
    fontSize: '20px', fontWeight: 'bold', color: '#004d7a', margin: '4px 0'
  }));
  
  summaryPanel.add(ui.Label('Confidence: ' + confVal.value + '% | Error: ±' + moeVal.value + '%', {
    fontSize: '11px', color: '#666'
  }));
  summaryPanel.add(ui.Label('t-value (df=' + result.df + '): ' + result.t_value.toFixed(3), {
    fontSize: '11px', color: '#666'
  }));
  summaryPanel.add(ui.Label('Margin of Error: ±' + result.E.toFixed(3) + ' kg/m²', {
    fontSize: '11px', color: '#666'
  }));
  summaryPanel.add(ui.Label('Iterations: ' + result.iterations + ' (converged)', {
    fontSize: '11px', color: '#666'
  }));
  summaryPanel.add(ui.Label('Plot Size: ' + plotSizeHa + ' ha (' + (plotSizeHa * 10000) + ' m²)', {
    fontSize: '11px', color: '#666'
  }));
  
  sampleSizeResultsPanel.add(summaryPanel);
  
  // Allocation table
  sampleSizeResultsPanel.add(ui.Label('Proportional Allocation by Stratum', STYLES.SUBHEADER));
  
  var allocHeaderPanel = ui.Panel([
    ui.Label('Stratum', {fontWeight: 'bold', width: '140px'}),
    ui.Label('Plots', {fontWeight: 'bold', width: '60px'}),
    ui.Label('%', {fontWeight: 'bold', width: '50px'}),
    ui.Label('σ', {fontWeight: 'bold', width: '60px'})
  ], ui.Panel.Layout.flow('horizontal'), {margin: '8px 0 4px 0'});
  sampleSizeResultsPanel.add(allocHeaderPanel);
  
  result.strata.forEach(function(s) {
    var pct = ((s.points / result.n_total) * 100).toFixed(1);
    
    var rowPanel = ui.Panel([
      ui.Label(String(s.name), {width: '140px', fontSize: '11px'}),
      ui.Label(String(s.points), {width: '60px', fontSize: '11px', fontWeight: 'bold'}),
      ui.Label(pct + '%', {width: '50px', fontSize: '11px'}),
      ui.Label(s.stdDev.toFixed(2), {width: '60px', fontSize: '11px'})
    ], ui.Panel.Layout.flow('horizontal'), {margin: '2px 0'});
    sampleSizeResultsPanel.add(rowPanel);
  });
  
  sampleSizeResultsPanel.add(ui.Label(
    '► UNFCCC AR-AM-Tool-03 stratified methodology with proportional allocation',
    STYLES.INFO
  ));
  
  // Console output
  print('═══════════════════════════════════════════════════════');
  print('🌊 STRATIFIED SAMPLE SIZE CALCULATION');
  print('═══════════════════════════════════════════════════════');
  print('Method: UNFCCC AR-AM-Tool-03 (Stratified)');
  print('Total sample size:', result.n_total);
  print('Number of strata:', result.strata.length);
  print('Confidence:', confVal.value + '%');
  print('Margin of error:', moeVal.value + '%');
  print('t-value (df=' + result.df + '):', result.t_value.toFixed(3));
  print('Convergence iterations:', result.iterations);
  print('---');
  print('ALLOCATION BY STRATUM:');
  result.strata.forEach(function(s) {
    print('  • ' + s.name + ': ' + s.points + ' plots (' + 
          ((s.points / result.n_total) * 100).toFixed(1) + '%)');
  });
  print('═══════════════════════════════════════════════════════');
  
  generatePointsButton.setDisabled(false);
}

function generatePoints() {
  if (AppState.isProcessing) return;
  AppState.isProcessing = true;
  
  pointsResultsPanel.clear();
  pointsResultsPanel.add(ui.Label('⏳ Generating stratified random sample points...', STYLES.INFO));
  
  if (!AppState.allocationPlan || AppState.allocationPlan.length === 0) {
    pointsResultsPanel.clear();
    pointsResultsPanel.add(ui.Label('❌ Please calculate sample size first', STYLES.ERROR));
    AppState.isProcessing = false;
    return;
  }
  
  var active = AppState.getActiveStrata();
  
  StratifiedSampler.generateStratifiedRandomPoints(
    active,
    AppState.allocationPlan,
    function(points, error) {
      pointsResultsPanel.clear();
      AppState.isProcessing = false;
      
      if (error) {
        pointsResultsPanel.add(ui.Label('❌ ' + error, STYLES.ERROR));
        return;
      }
      
      AppState.currentPoints = points;
      
      points.size().evaluate(function(count) {
        // Clear previous layers
        var layersToRemove = [];
        map.layers().forEach(function(layer) {
          if (layer.getName().indexOf('Sampling Points') === 0) {
            layersToRemove.push(layer);
          }
        });
        layersToRemove.forEach(function(layer) {
          map.layers().remove(layer);
        });
        
        // Add new points
        map.addLayer(
          points,
          {color: '00796B'},
          'Sampling Points (' + count + ')'
        );
        
        pointsResultsPanel.add(ui.Label('✓ Points Generated Successfully', STYLES.SUCCESS));
        pointsResultsPanel.add(ui.Label(
          'Total Points: ' + count,
          {fontSize: '16px', fontWeight: 'bold', margin: '4px 0'}
        ));
        
        // Show breakdown
        AppState.allocationPlan.forEach(function(s) {
          if (s.points > 0) {
            pointsResultsPanel.add(ui.Label(
              '  • ' + s.name + ': ' + s.points + ' points',
              {fontSize: '11px', margin: '2px 0 2px 8px'}
            ));
          }
        });
        
        pointsResultsPanel.add(ui.Label(
          '► Stratified random sampling with inward buffer for edge avoidance',
          STYLES.INFO
        ));
        
        exportPointsButton.setDisabled(false);
        exportStrataButton.setDisabled(false);
      });
    }
  );
}

function exportPoints() {
  if (!AppState.currentPoints) {
    alert('No points to export. Please generate points first.');
    return;
  }
  
  downloadLinksPanel.clear();
  downloadLinksPanel.add(ui.Label('⏳ Preparing export...', STYLES.INFO));
  
  var fmt = exportFormatSelect.getValue();
  var formatType = (fmt === 'SHP') ? 'SHP' : fmt;
  
  try {
    var url = AppState.currentPoints.getDownloadURL({
      format: formatType,
      filename: 'blue_carbon_sample_points_' + Date.now()
    });
    
    downloadLinksPanel.clear();
    downloadLinksPanel.add(ui.Label('✓ Export Ready', {
      fontSize: '12px',
      fontWeight: 'bold',
      color: '#00796B',
      margin: '4px 0'
    }));
    
    var linkLabel = ui.Label('📥 Download Sample Points (' + fmt + ')', {
      color: '#1565C0',
      fontSize: '13px',
      fontWeight: 'bold',
      margin: '4px 0'
    });
    linkLabel.setUrl(url);
    linkLabel.style().set('cursor', 'pointer');
    downloadLinksPanel.add(linkLabel);
    
    downloadLinksPanel.add(ui.Label(
      'Includes: point_id, stratum_name, coordinates, sampling_type, date',
      {fontSize: '10px', color: '#666', margin: '4px 0'}
    ));
  } catch (e) {
    downloadLinksPanel.clear();
    downloadLinksPanel.add(ui.Label('❌ Export failed: ' + e, STYLES.ERROR));
  }
}

function exportStrata() {
  var active = AppState.getActiveStrata();
  
  if (!active) {
    alert('No strata to export. Please define strata first.');
    return;
  }
  
  downloadLinksPanel.clear();
  downloadLinksPanel.add(ui.Label('⏳ Preparing export...', STYLES.INFO));
  
  var fmt = exportFormatSelect.getValue();
  var formatType = (fmt === 'SHP') ? 'SHP' : fmt;
  
  try {
    var withMeta = active.map(function(f) {
      return f.set('area_ha', f.geometry().area().divide(10000));
    });
    
    var url = withMeta.getDownloadURL({
      format: formatType,
      filename: 'blue_carbon_strata_' + Date.now()
    });
    
    downloadLinksPanel.clear();
    downloadLinksPanel.add(ui.Label('✓ Export Ready', {
      fontSize: '12px',
      fontWeight: 'bold',
      color: '#00796B',
      margin: '4px 0'
    }));
    
    var linkLabel = ui.Label('📥 Download Strata Polygons (' + fmt + ')', {
      color: '#1565C0',
      fontSize: '13px',
      fontWeight: 'bold',
      margin: '4px 0'
    });
    linkLabel.setUrl(url);
    linkLabel.style().set('cursor', 'pointer');
    downloadLinksPanel.add(linkLabel);
    
    downloadLinksPanel.add(ui.Label(
      'Includes: stratum_name, area_ha, geometry',
      {fontSize: '10px', color: '#666', margin: '4px 0'}
    ));
  } catch (e) {
    downloadLinksPanel.clear();
    downloadLinksPanel.add(ui.Label('❌ Export failed: ' + e, STYLES.ERROR));
  }
}

function clearAll() {
  var confirmed = confirm('This will reset all data and settings. Continue?');
  if (!confirmed) return;
  
  AppState.reset();
  
  map.layers().reset();
  map.drawingTools().clear();
  map.drawingTools().setShown(false);
  
  stratificationModeSelect.setValue(null);
  stratumNameBox.setValue('');
  tier1EcosystemSelect.setValue(null);
  assetPathBox.setValue('');
  confidenceBox.setValue(CONFIG.DEFAULT_CONFIDENCE.toString());
  marginOfErrorBox.setValue(CONFIG.DEFAULT_MARGIN_OF_ERROR.toString());
  plotTypeSelect.setValue('Sediment Core (100 m²)');
  tierModeSelect.setValue('IPCC Tier 1 Defaults');
  exportFormatSelect.setValue('CSV');
  
  drawingPanel.style().set('shown', false);
  assetPanel.style().set('shown', false);
  tier2InputPanel.style().set('shown', false);
  customPlotSizeBox.style().set('shown', false);
  
  strataResultsPanel.clear();
  sampleSizeResultsPanel.clear();
  pointsResultsPanel.clear();
  downloadLinksPanel.clear();
  priorsSummaryPanel.clear();
  strataCheckboxPanel.clear();
  tier2StratumInputsPanel.clear();
  
  stratumListLabel.setValue('Defined Strata: None');
  drawingStatusLabel.setValue('');
  assetStatusLabel.setValue('');
  
  // Reset all button states
  drawButton.setDisabled(false);
  finishDrawingButton.setDisabled(true);
  finalizeStrataButton.setDisabled(true);
  calculateSampleSizeButton.setDisabled(true);
  generatePointsButton.setDisabled(true);
  exportPointsButton.setDisabled(true);
  exportStrataButton.setDisabled(true);
  
  map.setCenter(-95, 55, 4);
  
  print('✓ Tool reset - ready for new blue carbon assessment');
}

// =================================================================================
// === 8. INITIALIZATION ===========================================================
// =================================================================================

var drawingTools = map.drawingTools();
drawingTools.setShown(false);
drawingTools.setLinked(false);
drawingTools.setDrawModes(['polygon', 'rectangle']);

// NOTE: We don't use onDraw() automatic handler anymore
// User manually clicks "Finish & Add This Stratum" button instead
// This provides clearer workflow and better control

map.setControlVisibility({
  layerList: true,
  drawingToolsControl: false,
  fullscreenControl: true,
  zoomControl: true
});

// Console welcome
print('═══════════════════════════════════════════════════════');
print('🌊 Blue Carbon Stratified Random Sampling Tool v3.0');
print('═══════════════════════════════════════════════════════');
print('');
print('METHODOLOGY:');
print('  • UNFCCC AR-AM-Tool-03 stratified sampling');
print('  • Proportional allocation by area');
print('  • IPCC Tier 1/2 carbon priors');
print('  • Iterative t-distribution convergence');
print('');
print('SUPPORTED ECOSYSTEMS:');
print('  • Salt Marsh (High/Low productivity)');
print('  • Seagrass (Dense/Sparse)');
print('  • Custom blue carbon systems');
print('');
print('WORKFLOW:');
print('  1. Define ecosystem strata (draw or upload)');
print('  2. Configure carbon priors (Tier 1/2)');
print('  3. Calculate stratified sample size');
print('  4. Generate stratified random points');
print('  5. Export sampling design');
print('');
print('Ready for blue carbon assessment! 🍁🌊');
print('═══════════════════════════════════════════════════════');
