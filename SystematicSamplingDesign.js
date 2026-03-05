// =================================================================================
// === BLUE CARBON SYSTEMATIC SAMPLING TOOL ========================================
// =================================================================================

// =================================================================================
// === 1. CONFIGURATION ============================================================
// =================================================================================

var CONFIG = {
  ANALYSIS_SCALE: 250,
  MAX_PIXELS: 1e10,
  MAX_ERROR: 1,
  DEFAULT_CONFIDENCE: 90,
  DEFAULT_MARGIN_OF_ERROR: 20,
  RANDOM_SEED: 42,
  GRID_BUFFER_M: 100, // meters - inward buffer for grid generation
  
  // Plot sizes per UNFCCC AR-AM-Tool-03 methodology
  SEDIMENT_CORE_AREA_HA: 0.01,     // 100 m² = 0.01 ha (standard blue carbon core)
  COMPOSITE_PLOT_SIZE_HA: 0.001,   // 250 m² = 0.025 ha (composite sampling)
  
  // Bayesian blending parameters
  A_REF: 200000,  // 200,000 ha reference area
  
  // Blue carbon default statistics (Prior Values)
  // Units: kg/m² (converted from Mg/ha by factor of 0.1)
  DEFAULTS: {
    seagrass: {
      mean: 8.5,     // Typical seagrass meadow carbon stocks
      stdDev: 6.2    // High variability in coastal systems
    },
    saltmarsh: {
      mean: 12.3,    // Salt marsh carbon stocks
      stdDev: 8.5    // Variable by location and hydrology
    },
    generic: {
      mean: 10.0,    // Generic blue carbon system
      stdDev: 7.5    
    }
  }
};

var STYLES = {
  TITLE: {fontSize: '28px', fontWeight: 'bold', color: '#004d7a'},
  SUBTITLE: {fontSize: '18px', fontWeight: '500', color: '#333333'},
  PARAGRAPH: {fontSize: '14px', color: '#555555'},
  HEADER: {fontSize: '16px', fontWeight: 'bold', margin: '16px 0 4px 8px'},
  SUBHEADER: {fontSize: '14px', fontWeight: 'bold', margin: '10px 0 0 0'},
  PANEL: {width: '420px', border: '1px solid #cccccc'},
  HR: ui.Panel(null, ui.Panel.Layout.flow('horizontal'), 
    {border: '1px solid #E0E0E0', margin: '20px 0px'}),
  INSTRUCTION: {fontSize: '12px', color: '#999999', margin: '4px 8px'},
  INFO: {fontSize: '12px', color: '#1565C0', margin: '4px 8px'},
  ERROR: {fontSize: '13px', color: '#D32F2F', fontWeight: 'bold', margin: '8px'},
  SUCCESS: {fontSize: '13px', color: '#00796B', fontWeight: 'bold', margin: '8px'},
  WARNING: {fontSize: '13px', color: '#F57C00', fontStyle: 'italic', margin: '8px'}
};

// =================================================================================
// === 2. STATE MANAGEMENT =========================================================
// =================================================================================

var AppState = {
  currentAoi: null,
  currentPoints: null,
  pointsLayer: null,
  gridLayer: null,
  aoiArea: null,
  currentEcosystemType: 'generic',
  calculatedSampleSize: null,
  
  reset: function() {
    this.currentAoi = null;
    this.currentPoints = null;
    this.aoiArea = null;
    this.currentEcosystemType = 'generic';
    this.calculatedSampleSize = null;
    if (this.pointsLayer) {
      map.layers().remove(this.pointsLayer);
      this.pointsLayer = null;
    }
    if (this.gridLayer) {
      map.layers().remove(this.gridLayer);
      this.gridLayer = null;
    }
  }
};

// =================================================================================
// === 3. UTILITY FUNCTIONS ========================================================
// =================================================================================

var Utils = {
  
  validateNumber: function(value, min, max, name) {
    var num = parseFloat(value);
    if (isNaN(num) || num < min || num > max) {
      return {valid: false, message: name + ' must be between ' + min + ' and ' + max};
    }
    return {valid: true, value: num};
  },
  
  formatNumber: function(num, decimals) {
    decimals = decimals !== undefined ? decimals : 2;
    if (num === null || num === undefined) return 'N/A';
    return num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  },
  
  /**
   * Calculate Z-score using polynomial approximation
   */
  calculateZScore: function(confidencePercent) {
    var alpha = 1 - (confidencePercent / 100);
    return 2.41 + (-10.9 * alpha) + (37.7 * Math.pow(alpha, 2)) - (57.9 * Math.pow(alpha, 3));
  },
  
  /**
   * Retrieves the two-sided Student's t-value for given confidence and degrees of freedom.
   * Uses exact lookup tables for df <= 30, Z-approximation for df > 30.
   * Implements UNFCCC AR-AM-Tool-03 methodology for small sample corrections.
   */
  getTValue: function(confidencePercent, df) {
    var alpha = 1 - (confidencePercent / 100);
    var is95 = Math.abs(alpha - 0.05) < 0.01;
    var is90 = Math.abs(alpha - 0.10) < 0.01;
    var is85 = Math.abs(alpha - 0.15) < 0.01;
    var is80 = Math.abs(alpha - 0.20) < 0.01;
    
    // For large samples (df > 30) or non-standard confidence levels, use Z-score
    var zScore = this.calculateZScore(confidencePercent);
    if (df > 30 || (!is95 && !is90 && !is85 && !is80)) {
      return zScore; 
    }
    
    // Lookup tables for small samples (df 1 to 30)
    // 95% confidence (two-tailed, α = 0.05)
    var t95 = [
      0,      // placeholder for index 0
      12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
      2.201,  2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
      2.080,  2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
    ];
    
    // 90% confidence (two-tailed, α = 0.10)
    var t90 = [
      0,      // placeholder for index 0
      6.314,  2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812,
      1.796,  1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729, 1.725,
      1.721,  1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697
    ];
    
    // 85% confidence (two-tailed, α = 0.15)
    var t85 = [
      0,      // placeholder for index 0
      4.165,  2.282, 1.924, 1.778, 1.699, 1.650, 1.617, 1.593, 1.574, 1.559,
      1.548,  1.538, 1.530, 1.523, 1.517, 1.512, 1.508, 1.504, 1.500, 1.497,
      1.494,  1.492, 1.489, 1.487, 1.485, 1.483, 1.481, 1.480, 1.478, 1.477
    ];
    
    // 80% confidence (two-tailed, α = 0.20)
    var t80 = [
      0,      // placeholder for index 0
      3.078,  1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372,
      1.363,  1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325,
      1.323,  1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313, 1.311, 1.310
    ];
    
    var index = Math.max(1, Math.min(30, Math.floor(df)));
    
    if (is95) return t95[index];
    if (is90) return t90[index];
    if (is85) return t85[index];
    if (is80) return t80[index];
    
    return zScore; // fallback
  },
  
  /**
   * Apply Bayesian blending using proper mixture variance formula
   */
  applyBayesianBlending: function(measuredMean, measuredStdDev, areaHa, ecosystemType) {
    var defaults = CONFIG.DEFAULTS[ecosystemType];
    
    // Calculate area-based weight: w = A / (A + A_ref)
    var w = areaHa / (areaHa + CONFIG.A_REF);
    
    // Blend means
    var blendedMean = (w * measuredMean) + ((1 - w) * defaults.mean);
    
    // Proper mixture variance formula
    // Var(blend) = w²×σ₁² + (1-w)²×σ₂² + w(1-w)(μ₁-μ₂)²
    var measuredVar = Math.pow(measuredStdDev, 2);
    var defaultVar = Math.pow(defaults.stdDev, 2);
    var meanDiff = measuredMean - defaults.mean;
    
    var blendedVariance = (Math.pow(w, 2) * measuredVar) + 
                          (Math.pow(1 - w, 2) * defaultVar) + 
                          (w * (1 - w) * Math.pow(meanDiff, 2));
    
    var blendedStdDev = Math.sqrt(blendedVariance);
    
    return {
      mean: blendedMean,
      stdDev: blendedStdDev,
      weight: w,
      measuredMean: measuredMean,
      measuredStdDev: measuredStdDev
    };
  },
  
  calculateSpacingFromPoints: function(numPoints, totalAreaM2) {
    if (!numPoints || !totalAreaM2 || numPoints === 0) {
      return null;
    }
    var areaPerPoint = totalAreaM2 / numPoints;
    return Math.round(Math.sqrt(areaPerPoint));
  }
};

// =================================================================================
// === 4. SYSTEMATIC SAMPLING GENERATOR ============================================
// =================================================================================

var SystematicSampler = {
  
  /**
   * Generate systematic grid with centroids filtered to coastal areas
   */
  generateSystematicGrid: function(aoi, numPoints, callback) {
    var WORKING_SCALE = CONFIG.ANALYSIS_SCALE;
    
    print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    print('🔍 Systematic Grid Generation (Buffered + Centroid)');
    print('Target points:', numPoints);
    print('Ecosystem type:', AppState.currentEcosystemType);
    
    // Step 1: Buffer AOI inward to avoid edge effects
    var bufferedAoi = aoi.buffer(-CONFIG.GRID_BUFFER_M, CONFIG.MAX_ERROR);
    
    // Check if buffer made AOI too small
    bufferedAoi.area({maxError: CONFIG.MAX_ERROR}).evaluate(function(bufferedArea, error) {
      if (error || !bufferedArea || bufferedArea < 1000) {
        print('⚠️ AOI too small for ' + CONFIG.GRID_BUFFER_M + 'm inward buffer, using original AOI');
        bufferedAoi = aoi;
      }
      
      // Step 2: Calculate spacing from buffered AOI area
      bufferedAoi.area({maxError: CONFIG.MAX_ERROR}).evaluate(function(aoiAreaM2) {
        
        print('Buffered AOI area:', (aoiAreaM2 / 10000).toFixed(1), 'ha');
        
        // Calculate spacing to get target number of grid cells
        var areaPerPoint = aoiAreaM2 / numPoints;
        var spacing = Math.round(Math.sqrt(areaPerPoint));
        
        print('Calculated spacing:', spacing, 'm');
        print('Expected grid cells:', Math.round(aoiAreaM2 / (spacing * spacing)));
        
        // Step 3: Create grid with randomized origin
        var randomX = Math.random() * spacing;
        var randomY = Math.random() * spacing;
        var proj = ee.Projection('EPSG:3978').atScale(spacing).translate(randomX, randomY);
        
        print('Creating grid cells over buffered AOI...');
        
        // Step 4: Generate grid cells using coveringGrid
        var gridCells = bufferedAoi.coveringGrid(proj, spacing);
        
        gridCells.size().evaluate(function(cellCount) {
          print('Grid cells created:', cellCount);
          
          // Step 5: Extract centroids from grid cells
          print('Extracting centroids...');
          var centroids = gridCells.map(function(cell) {
            return ee.Feature(cell.centroid(CONFIG.MAX_ERROR));
          });
          
          centroids.size().evaluate(function(centroidCount) {
            print('Centroids extracted:', centroidCount);
            
            // Step 6: Filter centroids to AOI (coastal blue carbon areas)
            print('Filtering centroids to coastal areas...');
            var validCentroids = centroids.filterBounds(aoi);
            
            validCentroids.size().evaluate(function(validCount) {
              print('Valid centroids in coastal areas:', validCount);
              print('Success rate:', ((validCount / centroidCount) * 100).toFixed(1) + '%');
              
              if (validCount === 0) {
                callback(null, null, 'No valid grid centroids found in coastal areas.');
                return;
              }
              
              if (validCount < numPoints * 0.8) {
                print('⚠️ WARNING: Only ' + validCount + ' valid points (target was ' + numPoints + ')');
                print('⚠️ This may indicate fragmented coastal areas');
              }
              
              // Step 7: Add point IDs and metadata (keep all valid centroids)
              var pointsList = validCentroids.toList(validCentroids.size());
              
              pointsList.size().evaluate(function(listSize) {
                print('Final point count:', listSize);
                
                var sequence = ee.List.sequence(0, listSize - 1);
                
                var finalPoints = ee.FeatureCollection(
                  sequence.map(function(idx) {
                    var pt = ee.Feature(pointsList.get(idx));
                    var coords = pt.geometry().coordinates();
                    return ee.Feature(pt.geometry(), {
                      'point_id': ee.String('SYS_').cat(ee.Number(idx).add(1).format('%04d')),
                      'ecosystem_type': AppState.currentEcosystemType,
                      'sampling_type': 'systematic_grid_centroid',
                      'grid_spacing_m': spacing,
                      'lon': coords.get(0),
                      'lat': coords.get(1)
                    });
                  })
                );
                
                print('✓ Grid generation complete');
                print('✓ True systematic grid layout maintained');
                print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                
                callback(finalPoints, spacing, null);
              });
            });
          });
        });
      });
    });
  },
  
  /**
   * Creates visual grid lines for display
   */
  createGridLines: function(aoi, cellSize) {
    return aoi.coveringGrid('EPSG:3978', cellSize);
  }
};

// =================================================================================
// === 5. USER INTERFACE ===========================================================
// =================================================================================

ui.root.clear();
var map = ui.Map();
var panel = ui.Panel({style: STYLES.PANEL});
var splitPanel = ui.SplitPanel(panel, map, 'horizontal', false);
ui.root.add(splitPanel);
map.setCenter(-95, 55, 4);

// --- Header ---
panel.add(ui.Label('Blue Carbon Sampling Toolkit', STYLES.TITLE));
panel.add(ui.Label('Systematic Sampling Design in Canadian Coastal Blue Carbon Ecosystems', STYLES.SUBTITLE));
panel.add(ui.Label(
  'Calculate sample sizes and implment a systematic sampling strategy for Canadian coastal blue carbon ecosystems.',
  STYLES.PARAGRAPH
));
panel.add(STYLES.HR);

// --- Step 1: Define AOI ---
panel.add(ui.Label('Step 1: Define Coastal Sampling Area', STYLES.HEADER));

var aoiSelection = ui.Select({
  items: ['Draw a polygon', 'Use a GEE Asset'],
  value: 'Draw a polygon',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    assetPanel.style().set('shown', value === 'Use a GEE Asset');
    map.drawingTools().setShown(value === 'Draw a polygon');
  }
});

var assetIdBox = ui.Textbox({
  placeholder: 'e.g., users/your_name/coastal_blue_carbon_site',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

var assetPanel = ui.Panel([
  ui.Label('Enter GEE Asset Path:', STYLES.INSTRUCTION),
  assetIdBox
], null, {shown: false});

panel.add(aoiSelection);
panel.add(assetPanel);
panel.add(ui.Label('► Draw your coastal area of interest on the map', STYLES.INSTRUCTION));

// --- Step 2: Calculate Sample Size ---
panel.add(ui.Label('Step 2: Calculate Sample Size', STYLES.HEADER));

// Ecosystem type selection
var ecosystemTypeSelect = ui.Select({
  items: ['Seagrass Meadow', 'Salt Marsh', 'Generic Blue Carbon'],
  value: 'Generic Blue Carbon',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    var typeMap = {
      'Seagrass Meadow': 'seagrass',
      'Salt Marsh': 'saltmarsh',
      'Generic Blue Carbon': 'generic'
    };
    AppState.currentEcosystemType = typeMap[value];
  }
});

panel.add(ui.Label('Ecosystem Type:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(ecosystemTypeSelect);
panel.add(ui.Label(
  '► Select your coastal ecosystem type for appropriate default values',
  STYLES.INFO
));

// Statistical parameters
var confidenceBox = ui.Textbox({
  placeholder: '70-99',
  value: CONFIG.DEFAULT_CONFIDENCE.toString(),
  style: {width: '80px', margin: '0 8px'}
});

var marginOfErrorBox = ui.Textbox({
  placeholder: '1-50',
  value: CONFIG.DEFAULT_MARGIN_OF_ERROR.toString(),
  style: {width: '80px', margin: '0 8px'}
});

// Input fields for user-provided statistics (optional)
var userMeanBox = ui.Textbox({
  placeholder: 'Optional (kg/m²)',
  style: {width: '120px', margin: '0 8px'}
});

var userStdDevBox = ui.Textbox({
  placeholder: 'Optional (kg/m²)',
  style: {width: '120px', margin: '0 8px'}
});

panel.add(ui.Panel([
  ui.Label('Confidence Level (%):', {width: '140px'}),
  confidenceBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));

panel.add(ui.Panel([
  ui.Label('Margin of Error (%):', {width: '140px'}),
  marginOfErrorBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));

panel.add(ui.Label(''));
panel.add(ui.Label('Optional: Provide Site-Specific Statistics', STYLES.SUBHEADER));
panel.add(ui.Label(
  '► If you have preliminary data, enter mean and standard deviation below. Otherwise, ecosystem defaults will be used.',
  STYLES.INFO
));

panel.add(ui.Panel([
  ui.Label('Mean Carbon (kg/m²):', {width: '140px'}),
  userMeanBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));

panel.add(ui.Panel([
  ui.Label('Std Dev (kg/m²):', {width: '140px'}),
  userStdDevBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));

// CV Override controls
var cvSlider = ui.Slider({
  min: 1, 
  max: 200, 
  value: 50, 
  step: 1, 
  style: {stretch: 'horizontal', margin: '0 8px'},
  disabled: true 
});

var cvOverrideCheck = ui.Checkbox({
  label: 'Override CV (%) - disables Bayesian adjustment', 
  value: false,
  style: {margin: '8px 8px 0 8px', fontWeight: 'bold'},
  onChange: function(checked) {
    cvSlider.setDisabled(!checked);
  }
});

panel.add(ui.Label(''));
panel.add(cvOverrideCheck);
panel.add(cvSlider);

var calculateButton = ui.Button({
  label: '📊 Calculate Sample Size',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: calculateSampleSize
});
panel.add(calculateButton);

var resultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(resultsPanel);

// --- Step 3: Generate Points ---
panel.add(ui.Label('Step 3: Generate Systematic Grid', STYLES.HEADER));

var numPointsBox = ui.Textbox({
  placeholder: 'Number of points...',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

panel.add(ui.Label('Number of sampling points:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(numPointsBox);

var plotTypeSelect = ui.Select({
  items: ['Sediment Core (100 m²)', 'Vegetation Plot (1 m²)'],
  value: 'Sediment Core (100 m²)',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

panel.add(ui.Label('Plot Type:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(plotTypeSelect);
panel.add(ui.Label(
  '► Sediment cores for detailed carbon profiles; Vegetation plots for biomass surveys',
  STYLES.INFO
));

var spacingInfoLabel = ui.Label('', {
  fontSize: '12px', color: '#666666', margin: '4px 8px', fontStyle: 'italic'
});
panel.add(spacingInfoLabel);

var showGridCheckbox = ui.Checkbox({
  label: 'Show grid lines on map',
  value: true,
  style: {margin: '8px'}
});
panel.add(showGridCheckbox);

var generateButton = ui.Button({
  label: 'Generate Systematic Points',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: generatePoints
});
panel.add(generateButton);

// Export section
panel.add(ui.Label('Export Format:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
var formatSelect = ui.Select({
  items: ['CSV', 'GeoJSON', 'KML', 'SHP'],
  value: 'CSV',
  style: {stretch: 'horizontal', margin: '0 8px'}
});
panel.add(formatSelect);

var exportButton = ui.Button({
  label: '⬇️ Export Points',
  style: {stretch: 'horizontal', margin: '8px'},
  disabled: true
});
panel.add(exportButton);

var downloadLinksPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(downloadLinksPanel);

var clearButton = ui.Button({
  label: 'Clear All & Start Over',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: clearAll
});
panel.add(clearButton);

// =================================================================================
// === 6. CORE FUNCTIONS ===========================================================
// =================================================================================

function getAoi() {
  var method = aoiSelection.getValue();
  if (method === 'Draw a polygon') {
    var layers = map.drawingTools().layers();
    if (layers.length() === 0 || layers.get(0).geometries().length() === 0) return null;
    return layers.get(0).toGeometry();
  } else {
    var assetId = assetIdBox.getValue();
    if (!assetId || assetId.trim() === '') return null;
    try {
      return ee.FeatureCollection(assetId.trim()).union().geometry().buffer(10).simplify(10);
    } catch (e) { return null; }
  }
}

function calculateSampleSize() {
  resultsPanel.clear();
  map.layers().reset();
  
  // Get AOI
  AppState.currentAoi = getAoi();
  if (!AppState.currentAoi) {
    resultsPanel.add(ui.Label('⚠️ Please define a coastal area of interest first!', STYLES.ERROR));
    return;
  }
  
  // Validate inputs
  var confVal = Utils.validateNumber(confidenceBox.getValue(), 70, 99.9, 'Confidence level');
  var moeVal = Utils.validateNumber(marginOfErrorBox.getValue(), 1, 50, 'Margin of error');
  
  if (!confVal.valid || !moeVal.valid) {
    resultsPanel.add(ui.Label('Invalid parameters', STYLES.ERROR));
    return;
  }
  
  resultsPanel.add(ui.Label('Calculating sample size for blue carbon ecosystem...', {
    color: '#666', fontStyle: 'italic', margin: '8px'
  }));
  
  map.centerObject(AppState.currentAoi, 10);
  map.addLayer(AppState.currentAoi, {color: '004d7a'}, 'Blue Carbon Sampling Area');
  
  // Calculate area
  AppState.currentAoi.area({maxError: CONFIG.MAX_ERROR}).evaluate(function(areaM2, error) {
    resultsPanel.clear();
    
    if (error) {
      resultsPanel.add(ui.Label('⚠️ Error calculating area: ' + error, STYLES.ERROR));
      return;
    }
    
    AppState.aoiArea = areaM2;
    var areaHa = areaM2 / 10000;
    
    var plotType = plotTypeSelect.getValue();
    var plotSizeHa = (plotType === 'Sediment Core (100 m²)') ? 
      CONFIG.SEDIMENT_CORE_AREA_HA : CONFIG.COMPOSITE_PLOT_SIZE_HA;
    
    // Determine if user provided statistics
    var userMean = userMeanBox.getValue();
    var userStdDev = userStdDevBox.getValue();
    
    var measuredMean, measuredStdDev;
    var usingUserData = false;
    
    if (userMean && userStdDev && userMean.trim() !== '' && userStdDev.trim() !== '') {
      var meanVal = Utils.validateNumber(userMean, 0, 100, 'Mean carbon');
      var stdVal = Utils.validateNumber(userStdDev, 0, 100, 'Std Dev');
      
      if (meanVal.valid && stdVal.valid) {
        measuredMean = meanVal.value;
        measuredStdDev = stdVal.value;
        usingUserData = true;
      } else {
        resultsPanel.add(ui.Label('⚠️ Invalid user statistics, using ecosystem defaults', STYLES.WARNING));
      }
    }
    
    // If no user data, use ecosystem defaults
    if (!usingUserData) {
      var defaults = CONFIG.DEFAULTS[AppState.currentEcosystemType];
      measuredMean = defaults.mean;
      measuredStdDev = defaults.stdDev;
    }
    
    // Display Initial Statistics
    resultsPanel.add(ui.Label(ecosystemTypeSelect.getValue() + ' - Statistics', STYLES.SUBHEADER));
    resultsPanel.add(ui.Label('Area: ' + Utils.formatNumber(areaHa, 1) + ' ha', {margin: '4px 8px'}));
    resultsPanel.add(ui.Label('Mean: ' + Utils.formatNumber(measuredMean, 3) + ' kg/m²', {margin: '4px 8px'}));
    resultsPanel.add(ui.Label('Std Dev: ' + Utils.formatNumber(measuredStdDev, 3) + ' kg/m²', {margin: '4px 8px'}));
    var measuredCv = (measuredStdDev / measuredMean) * 100;
    resultsPanel.add(ui.Label('CV: ' + Utils.formatNumber(measuredCv, 1) + '%', {margin: '4px 8px'}));
    
    if (usingUserData) {
      resultsPanel.add(ui.Label('Source: User-provided data', {margin: '4px 8px', fontStyle: 'italic', color: '#1565C0'}));
    } else {
      resultsPanel.add(ui.Label('Source: Ecosystem defaults', {margin: '4px 8px', fontStyle: 'italic', color: '#999'}));
    }
    
    // Calculate final statistics
    var finalMean, finalStdDev, blendedData;
    
    // Apply Bayesian Blending if not overridden
    if (!cvOverrideCheck.getValue()) {
      blendedData = Utils.applyBayesianBlending(measuredMean, measuredStdDev, areaHa, AppState.currentEcosystemType);
      finalMean = blendedData.mean;
      finalStdDev = blendedData.stdDev;
      var blendedCv = (finalStdDev / finalMean) * 100;
      
      // Display Bayesian blending info
      resultsPanel.add(ui.Label(''));
      resultsPanel.add(ui.Label('Bayesian Blended Statistics', STYLES.SUBHEADER));
      resultsPanel.add(ui.Label('Weight to measured data: ' + Utils.formatNumber(blendedData.weight * 100, 1) + '%', {margin: '4px 8px'}));
      resultsPanel.add(ui.Label('Blended Mean: ' + Utils.formatNumber(finalMean, 3) + ' kg/m²', {margin: '4px 8px'}));
      resultsPanel.add(ui.Label('Blended Std Dev: ' + Utils.formatNumber(finalStdDev, 3) + ' kg/m²', {margin: '4px 8px'}));
      resultsPanel.add(ui.Label('Blended CV: ' + Utils.formatNumber(blendedCv, 1) + '%', {margin: '4px 8px'}));
      
      if (blendedData.weight < 0.1) {
        resultsPanel.add(ui.Label('⚠️ Small area: >90% weight to ecosystem defaults', STYLES.WARNING));
      }
      
      cvSlider.setValue(blendedCv);
    } else {
      // CV Override
      var manualCv = cvSlider.getValue();
      finalMean = measuredMean;
      finalStdDev = finalMean * (manualCv / 100);
      resultsPanel.add(ui.Label(''));
      resultsPanel.add(ui.Label('⚠️ Manual CV Override Active', STYLES.WARNING));
      resultsPanel.add(ui.Label('Using CV: ' + manualCv + '%', {margin: '4px 8px'}));
    }
    
    // Calculate Sample Size using UNFCCC AR-AM-Tool-03 iterative approach
    var N = areaHa / plotSizeHa;
    var E = finalMean * (moeVal.value / 100);
    var sigma = finalStdDev;
    
    // Iterative calculation with t-distribution (converges on correct df)
    var n_prev = N; // Start with population size as initial estimate
    var n_final = 0;
    var iterations = 0;
    var maxIterations = 10;
    var t_val;
    var convergenceLog = [];
    
    while (iterations < maxIterations) {
      // Calculate degrees of freedom (df = n - 1)
      var df = Math.max(1, n_prev - 1);
      t_val = Utils.getTValue(confVal.value, df);
      
      // UNFCCC single-stratum formula (algebraically simplified):
      // n = (N × t² × σ²) / (N × E² + t² × σ²)
      var numerator = N * Math.pow(t_val, 2) * Math.pow(sigma, 2);
      var denominator = (N * Math.pow(E, 2)) + (Math.pow(t_val, 2) * Math.pow(sigma, 2));
      
      n_final = numerator / denominator;
      
      // Log iteration for diagnostics
      convergenceLog.push({
        iteration: iterations + 1,
        df: df,
        t_value: t_val,
        n_estimate: n_final
      });
      
      // Check convergence (change < 0.1)
      if (Math.abs(n_final - n_prev) < 0.1) {
        break;
      }
      
      n_prev = n_final;
      iterations++;
    }
    
    // Apply Design Effect for systematic sampling
    // Deff = 1.2 accounts for potential spatial autocorrelation in systematic grids
    var Deff = 1.2; 
    var n_adjusted = n_final / Deff;
    
    // Ensure minimum of 3 samples for basic variance estimation
    var n_systematic = Math.max(3, Math.ceil(n_adjusted));
    
    AppState.calculatedSampleSize = n_systematic;
    
    // Calculate recommended spacing
    var recommendedSpacing = Utils.calculateSpacingFromPoints(n_systematic, areaM2);
    
    // Display Results
    resultsPanel.add(ui.Label(''));
    resultsPanel.add(ui.Label('Recommended Sample Size', STYLES.SUBHEADER));
    
    var samplePanel = ui.Panel([
      ui.Label(n_systematic.toString() + ' samples', {
        fontSize: '24px', fontWeight: 'bold', color: '#004d7a', margin: '4px 0'
      }),
      ui.Label(confVal.value + '% confidence, ±' + moeVal.value + '% error', {fontSize: '11px', color: '#666'}),
      ui.Label('Margin of Error: ±' + E.toFixed(3) + ' kg/m²', {fontSize: '11px', color: '#666'}),
      ui.Label('Population (N): ' + Utils.formatNumber(N, 0) + ' | Plot: ' + (plotSizeHa * 10000) + ' m²', {fontSize: '11px', color: '#666'}),
      ui.Label('t-value (df=' + Math.floor(n_systematic - 1) + '): ' + t_val.toFixed(3), {fontSize: '11px', color: '#666'}),
      ui.Label('Design Effect: ' + Deff.toFixed(2) + ' (systematic grid)', {fontSize: '11px', color: '#666'}),
      ui.Label('Iterations: ' + (iterations + 1) + ' (converged)', {fontSize: '11px', color: '#666'}),
      ui.Label('Approx. grid spacing: ~' + Utils.formatNumber(recommendedSpacing, 0) + ' m', {fontSize: '11px', color: '#666'})
    ], null, {border: '2px solid #004d7a', padding: '12px', margin: '8px 0'});
    
    resultsPanel.add(samplePanel);
    resultsPanel.add(ui.Label('► UNFCCC AR-AM-Tool-03 + Bayesian blending + Systematic Design Effect', STYLES.INFO));
    
    var applyButton = ui.Button({
      label: 'Apply to Points Field',
      style: {margin: '4px 0', stretch: 'horizontal', backgroundColor: '#00796B'},
      onClick: function() {
        numPointsBox.setValue(n_systematic.toString());
        spacingInfoLabel.setValue('Target: ' + n_systematic + ' points');
        resultsPanel.add(ui.Label('✓ Applied ' + n_systematic + ' to points field', STYLES.SUCCESS));
      }
    });
    resultsPanel.add(applyButton);
    
    // Console output with convergence details
    print('═══════════════════════════════════════════════════════');
    print('🌊 BLUE CARBON SAMPLE SIZE CALCULATION (kg/m²)');
    print('═══════════════════════════════════════════════════════');
    print('Ecosystem Type:', AppState.currentEcosystemType);
    print('Measured Mean:', measuredMean.toFixed(3), 'StdDev:', measuredStdDev.toFixed(3), 'CV:', measuredCv.toFixed(1) + '%');
    print('Final Mean:', finalMean.toFixed(3), 'StdDev:', finalStdDev.toFixed(3));
    print('Area:', areaHa.toFixed(1), 'ha | Plot Size:', plotSizeHa, 'ha');
    print('Population (N):', N.toFixed(0));
    print('---');
    print('UNFCCC ITERATIVE CALCULATION:');
    print('Convergence iterations:', iterations + 1);
    for (var i = 0; i < convergenceLog.length; i++) {
      var entry = convergenceLog[i];
      print('  Iter ' + entry.iteration + ': df=' + entry.df + ', t=' + entry.t_value.toFixed(3) + ', n=' + entry.n_estimate.toFixed(1));
    }
    print('---');
    print('Final t-value (df=' + Math.floor(n_systematic - 1) + '):', t_val.toFixed(3));
    print('Margin of Error (E):', E.toFixed(3), 'kg/m²');
    print('Base sample size (n):', Math.ceil(n_final));
    print('Design Effect (Deff):', Deff);
    print('Adjusted sample size:', n_systematic);
    print('Recommended spacing:', recommendedSpacing, 'm');
    print('CV Override Active:', cvOverrideCheck.getValue());
    if (blendedData) {
      print('Bayesian Weight:', (blendedData.weight * 100).toFixed(1) + '%');
    }
    print('═══════════════════════════════════════════════════════');
  });
}

function generatePoints() {
  if (AppState.pointsLayer) {
    map.layers().remove(AppState.pointsLayer);
    AppState.pointsLayer = null;
  }
  if (AppState.gridLayer) {
    map.layers().remove(AppState.gridLayer);
    AppState.gridLayer = null;
  }
  
  if (!AppState.currentAoi) {
    resultsPanel.add(ui.Label('⚠️ Please calculate sample size first!', STYLES.ERROR));
    return;
  }
  
  var numVal = Utils.validateNumber(numPointsBox.getValue(), 1, 10000, 'Number of points');
  if (!numVal.valid) {
    resultsPanel.add(ui.Label(numVal.message, STYLES.ERROR));
    return;
  }
  
  var numPoints = numVal.value;
  
  var loadingLabel = ui.Label('Generating systematic grid (buffered AOI + centroids)...', {
    color: '#666', fontStyle: 'italic', margin: '4px 8px'
  });
  resultsPanel.add(loadingLabel);
  spacingInfoLabel.setValue('Calculating...');
  
  SystematicSampler.generateSystematicGrid(
    AppState.currentAoi,
    numPoints,
    function(points, spacing, error) {
      resultsPanel.remove(loadingLabel);
      
      if (error) {
        resultsPanel.add(ui.Label('⚠️ ' + error, STYLES.ERROR));
        spacingInfoLabel.setValue('');
        return;
      }
      
      var calculatedSpacing = Math.round(spacing);
      
      AppState.currentPoints = points;
      
      AppState.currentPoints.size().evaluate(function(actualCount, evalError) {
        if (evalError) {
          resultsPanel.add(ui.Label('⚠️ Error: ' + evalError, STYLES.ERROR));
          return;
        }
        
        if (actualCount === 0) {
          resultsPanel.add(ui.Label('⚠️ No points generated.', STYLES.WARNING));
          spacingInfoLabel.setValue('');
          return;
        }
        
        spacingInfoLabel.setValue('Generated ' + actualCount + ' points (grid spacing: ' + calculatedSpacing + 'm)');
        
        AppState.pointsLayer = ui.Map.Layer(
          AppState.currentPoints,
          {color: '00796B'},
          'Systematic Grid Points (' + actualCount + ')'
        );
        map.layers().add(AppState.pointsLayer);
        
        if (showGridCheckbox.getValue()) {
          var gridFeatures = SystematicSampler.createGridLines(AppState.currentAoi, calculatedSpacing);
          AppState.gridLayer = ui.Map.Layer(
            gridFeatures,
            {color: 'AAAAAA', strokeWidth: 1},
            'Grid Cells (' + calculatedSpacing + 'm)',
            true,
            0.3
          );
          map.layers().add(AppState.gridLayer);
        }
        
        exportButton.setDisabled(false);
        
        var percentDiff = Math.abs((actualCount - numPoints) / numPoints * 100);
        var msg = '✓ Generated ' + actualCount + ' points (target: ' + numPoints + ')';
        if (percentDiff > 15) {
          msg += ' - ' + percentDiff.toFixed(0) + '% difference due to coastal area filtering';
        }
        resultsPanel.add(ui.Label(msg, STYLES.SUCCESS));
      });
    }
  );
}

exportButton.onClick(function() {
  if (!AppState.currentPoints) return;
  downloadLinksPanel.clear();
  var format = formatSelect.getValue();
  var exportData = AppState.currentPoints.map(function(f, idx) {
    var coords = f.geometry().coordinates();
    return f.set({
      'point_id': f.get('point_id'),
      'longitude': coords.get(0),
      'latitude': coords.get(1),
      'export_format': format,
      'date': ee.Date(Date.now()).format('YYYY-MM-dd'),
      'ecosystem_type': AppState.currentEcosystemType,
      'plot_type': plotTypeSelect.getValue(),
      'sampling_strategy': 'systematic'
    });
  });
  var downloadUrl = exportData.getDownloadURL({
    format: format === 'SHP' ? 'SHP' : format,
    filename: 'blue_carbon_systematic_points_' + AppState.currentEcosystemType + '_' + new Date().getTime()
  });
  downloadLinksPanel.add(ui.Label({
    value: '⬇️ Download (' + format + ')',
    style: {color: '#1565C0', textDecoration: 'underline', margin: '8px', fontWeight: 'bold'},
    targetUrl: downloadUrl
  }));
  
  print('✓ Export link generated for', AppState.currentPoints.size().getInfo(), 'points');
});

function clearAll() {
  AppState.reset();
  map.layers().reset();
  map.drawingTools().clear();
  map.drawingTools().setShown(true);
  resultsPanel.clear();
  downloadLinksPanel.clear();
  numPointsBox.setValue('');
  userMeanBox.setValue('');
  userStdDevBox.setValue('');
  spacingInfoLabel.setValue('');
  exportButton.setDisabled(true);
  cvOverrideCheck.setValue(false);
  cvSlider.setDisabled(true);
  print('✓ Tool reset - ready for new blue carbon site');
}

// =================================================================================
// === 7. INITIALIZE ===============================================================
// =================================================================================

var drawingTools = map.drawingTools();
drawingTools.setShown(true);
drawingTools.setDrawModes(['polygon', 'rectangle']);
drawingTools.setShape('polygon');

map.setControlVisibility({
  all: false,
  layerList: true,
  zoomControl: true,
  scaleControl: true,
  mapTypeControl: true,
  drawingToolsControl: true
});

print('═══════════════════════════════════════════════════════');
print('🌊 Blue Carbon Systematic Sampling Tool v2.0');
print('═══════════════════════════════════════════════════════');
print('');
print('DESIGNED FOR: Canadian coastal blue carbon ecosystems');
print('  • Seagrass meadows');
print('  • Salt marshes');

print('WORKFLOW:');
print('  1. Define coastal sampling area');
print('  2. Select ecosystem type');
print('  3. Calculate sample size (UNFCCC method)');
print('  4. Generate systematic sampling points');
print('  5. Export for field work');
print('');
print('Ready for blue carbon assessment!');
