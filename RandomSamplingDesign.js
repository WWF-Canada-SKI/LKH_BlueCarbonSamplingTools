// =================================================================================
// === BLUE CARBON RANDOM SAMPLING TOOL ===========================================
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
  MIN_POINT_DISTANCE: 50, // meters - minimum distance between sampling points
  
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
  aoiArea: null,
  currentEcosystemType: 'generic',
  
  reset: function() {
    this.currentAoi = null;
    this.currentPoints = null;
    this.aoiArea = null;
    this.currentEcosystemType = 'generic';
    if (this.pointsLayer) {
      map.layers().remove(this.pointsLayer);
      this.pointsLayer = null;
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
  }
};

// =================================================================================
// === 4. USER INTERFACE ===========================================================
// =================================================================================

ui.root.clear();
var map = ui.Map();
var panel = ui.Panel({style: STYLES.PANEL});
var splitPanel = ui.SplitPanel(panel, map, 'horizontal', false);
ui.root.add(splitPanel);
map.setCenter(-95, 55, 4);

// --- Header ---
panel.add(ui.Label('Blue Carbon Sampling Toolkit', STYLES.TITLE));
panel.add(ui.Label('Random Sampling Design in Canadian Coastal Blue Carbon Ecosystems', STYLES.SUBTITLE));
panel.add(ui.Label(
  'Calculate sample sizes and implement a randon sampling strategy for Canadian coastal blue carbon ecosystems',
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
  label: 'Override with custom CV (%)', 
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
panel.add(ui.Label('Step 3: Generate Sampling Points', STYLES.HEADER));

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
  '► Sediment cores for detailed carbon profiles; Vegetation plots to determine biomass ',
  STYLES.INFO
));

var generateButton = ui.Button({
  label: 'Generate Random Points',
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
// === 5. CORE FUNCTIONS ===========================================================
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
    
    // Calculate Sample Size using IPCC Equation 5
    var N = areaHa / plotSizeHa;
    var z = Utils.calculateZScore(confVal.value);
    var E = finalMean * (moeVal.value / 100);
    var sigma = finalStdDev;
    
    var numerator = N * Math.pow(sigma, 2) * Math.pow(z, 2);
    var denominator = (N - 1) * Math.pow(E, 2) + Math.pow(sigma, 2) * Math.pow(z, 2);
    var n_final = numerator / denominator;
    
    // Display Results
    resultsPanel.add(ui.Label(''));
    resultsPanel.add(ui.Label('Recommended Sample Size', STYLES.SUBHEADER));
    
    var samplePanel = ui.Panel([
      ui.Label(Math.ceil(n_final).toString() + ' samples', {
        fontSize: '24px', fontWeight: 'bold', color: '#004d7a', margin: '4px 0'
      }),
      ui.Label(confVal.value + '% confidence, ±' + moeVal.value + '% error', {fontSize: '11px', color: '#666'}),
      ui.Label('Margin of Error: ±' + E.toFixed(3) + ' kg/m²', {fontSize: '11px', color: '#666'}),
      ui.Label('Population (N): ' + Utils.formatNumber(N, 0) + ' | Plot: ' + (plotSizeHa * 10000) + ' m²', {fontSize: '11px', color: '#666'}),
      ui.Label('Z-score: ' + z.toFixed(3), {fontSize: '11px', color: '#666'})
    ], null, {border: '2px solid #004d7a', padding: '12px', margin: '8px 0'});
    
    resultsPanel.add(samplePanel);
    
    var applyButton = ui.Button({
      label: 'Apply to Points Field',
      style: {margin: '4px 0', stretch: 'horizontal', backgroundColor: '#00796B'},
      onClick: function() {
        numPointsBox.setValue(Math.ceil(n_final).toString());
        resultsPanel.add(ui.Label('✓ Applied ' + Math.ceil(n_final) + ' to points field', STYLES.SUCCESS));
      }
    });
    resultsPanel.add(applyButton);
    
    // Console output
    print('═══════════════════════════════════════════════════════');
    print('BLUE CARBON SAMPLE SIZE CALCULATION (kg/m²)');
    print('═══════════════════════════════════════════════════════');
    print('Ecosystem Type:', AppState.currentEcosystemType);
    print('Measured Mean:', measuredMean.toFixed(3), 'StdDev:', measuredStdDev.toFixed(3), 'CV:', measuredCv.toFixed(1) + '%');
    print('Final Mean:', finalMean.toFixed(3), 'StdDev:', finalStdDev.toFixed(3));
    print('Area:', areaHa.toFixed(1), 'ha | Plot Size:', plotSizeHa, 'ha');
    print('Population (N):', N.toFixed(0));
    print('Z-score:', z.toFixed(3), '| Error (E):', E.toFixed(3));
    print('Sample Size (n):', Math.ceil(n_final));
    print('CV Override Active:', cvOverrideCheck.getValue());
    if (blendedData) {
      print('Bayesian Weight:', (blendedData.weight * 100).toFixed(1) + '%');
    }
  });
}

function generatePoints() {
  if (AppState.pointsLayer) {
    map.layers().remove(AppState.pointsLayer);
    AppState.pointsLayer = null;
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
  
  resultsPanel.add(ui.Label('Generating spatially distributed sampling points...', {
    color: '#666', fontStyle: 'italic', margin: '4px 8px'
  }));
  
  // Generate random points within AOI (no carbon mask filtering)
  var candidatePoints = ee.FeatureCollection.randomPoints({
    region: AppState.currentAoi,
    points: numPoints * 5,
    seed: CONFIG.RANDOM_SEED
  });
  
  // Spatial filtering to maintain minimum distance
  var spatiallyFilteredPoints = ee.FeatureCollection(
    ee.List(candidatePoints.toList(numPoints * 3).iterate(
      function(point, list) {
        list = ee.List(list);
        point = ee.Feature(point);
        
        var existingPoints = ee.FeatureCollection(list);
        var tooClose = existingPoints.filterBounds(
          point.geometry().buffer(CONFIG.MIN_POINT_DISTANCE)
        ).size();
        
        return ee.Algorithms.If(
          tooClose.eq(0),
          list.add(point),
          list
        );
      },
      ee.List([])
    ))
  ).limit(numPoints);
  
  AppState.currentPoints = spatiallyFilteredPoints;
  
  AppState.currentPoints.size().evaluate(function(actualCount) {
    AppState.pointsLayer = ui.Map.Layer(
      AppState.currentPoints,
      {color: '00796B'},
      'Blue Carbon Sampling Points (' + actualCount + ')'
    );
    map.layers().add(AppState.pointsLayer);
    exportButton.setDisabled(false);
    
    if (actualCount < numPoints) {
      resultsPanel.add(ui.Label('⚠️ Generated ' + actualCount + ' points (requested ' + numPoints + ')', STYLES.WARNING));
      resultsPanel.add(ui.Label('Limited by AOI size or min. distance constraint', {
        fontSize: '11px', color: '#666', margin: '0 8px'
      }));
    } else {
      resultsPanel.add(ui.Label('✓ Generated ' + actualCount + ' points (min. ' + CONFIG.MIN_POINT_DISTANCE + 'm apart)', STYLES.SUCCESS));
    }
  });
}

exportButton.onClick(function() {
  if (!AppState.currentPoints) return;
  downloadLinksPanel.clear();
  var format = formatSelect.getValue();
  var exportData = AppState.currentPoints.map(function(f, idx) {
    var coords = f.geometry().coordinates();
    return f.set({
      'point_id': ee.Number(idx).add(1),
      'longitude': coords.get(0),
      'latitude': coords.get(1),
      'export_format': format,
      'date': ee.Date(Date.now()).format('YYYY-MM-dd'),
      'ecosystem_type': AppState.currentEcosystemType,
      'plot_type': plotTypeSelect.getValue(),
      'sampling_strategy': 'random'
    });
  });
  var downloadUrl = exportData.getDownloadURL({
    format: format === 'SHP' ? 'SHP' : format,
    filename: 'blue_carbon_sampling_points_' + AppState.currentEcosystemType + '_' + new Date().getTime()
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
  exportButton.setDisabled(true);
  cvOverrideCheck.setValue(false);
  cvSlider.setDisabled(true);
  print('✓ Tool reset - ready for new blue carbon site');
}

// =================================================================================
// === 6. INITIALIZE ===============================================================
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
print('🌊 Blue Carbon Sampling Tool');
print('═══════════════════════════════════════════════════════');
print('');
print('DESIGNED FOR: Canadian coastal blue carbon ecosystems');
print('  • Seagrass meadows');
print('  • Salt marshes');
print('');
print('WORKFLOW:');
print('  1. Define coastal sampling area');
print('  2. Select ecosystem type');
print('  3. Calculate sample size');
print('  4. Generate random sampling points');
print('  5. Export for field work');
print('');
print('Ready for blue carbon assessment!');
