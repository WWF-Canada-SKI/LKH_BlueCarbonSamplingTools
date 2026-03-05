// =================================================================================
// === BLUE CARBON COMPOSITE SAMPLING TOOL - CANADA EDITION =======================
// =================================================================================
// =================================================================================

var CONFIG = {
  DEFAULT_HR_CORES: 10,
  DEFAULT_COMPOSITES_PER_STRATUM: 20,
  DEFAULT_COMPOSITE_AREA: 25,
  DEFAULT_SUBSAMPLES: 5,
  DEFAULT_PAIRING_FRACTION: 0.4,
  DEFAULT_CONFIDENCE: 90,
  DEFAULT_MARGIN_OF_ERROR: 20,
  DEFAULT_CV: 0.15,
  CARBON_SCALE: 250,
  MAX_PIXELS: 1e10,
  MAX_ERROR: 1,
  EQUAL_AREA_PROJECTION: 'EPSG:3978',
  RANDOM_SEED: 42
};

var STYLES = {
  TITLE: {fontSize: '28px', fontWeight: 'bold', color: '#004d7a'},
  SUBTITLE: {fontSize: '18px', fontWeight: '500', color: '#333333'},
  PARAGRAPH: {fontSize: '14px', color: '#555555'},
  HEADER: {fontSize: '16px', fontWeight: 'bold', margin: '16px 0 4px 8px'},
  SUBHEADER: {fontSize: '14px', fontWeight: 'bold', margin: '10px 0 0 0'},
  PANEL: {width: '420px', border: '1px solid #cccccc'},
  HR: ui.Panel(null, ui.Panel.Layout.flow('horizontal'), {
    border: '1px solid #E0E0E0',
    margin: '20px 0px'
  }),
  INSTRUCTION: {fontSize: '12px', color: '#999999', margin: '4px 8px'},
  SUCCESS: {fontSize: '13px', color: '#00796B', fontWeight: 'bold', margin: '8px'},
  ERROR: {fontSize: '13px', color: '#D32F2F', fontWeight: 'bold', margin: '8px'},
  WARNING: {fontSize: '13px', color: '#F57C00', fontWeight: 'bold', margin: '8px'},
  INFO: {fontSize: '12px', color: '#1565C0', margin: '4px 8px'}
};

var soilCarbon = ee.ImageCollection("projects/sat-io/open-datasets/carbon_stocks_ca/sc").first();
var palettes = require('users/gena/packages:palettes');
var scVis = {palette: palettes.colorbrewer.Blues[7], min: 5, max: 30};

var AppState = {
  currentAoi: null,
  hrCores: null,
  composites: null,
  subsamples: null,
  pairedComposites: null,
  unpairedComposites: null,
  carbonStats: null,
  calculatedSampleSize: null,
  gridVisualization: null,
  currentCV: CONFIG.DEFAULT_CV,
  carbonDataset: soilCarbon,
  
  reset: function() {
    this.currentAoi = null;
    this.hrCores = null;
    this.composites = null;
    this.subsamples = null;
    this.pairedComposites = null;
    this.unpairedComposites = null;
    this.carbonStats = null;
    this.calculatedSampleSize = null;
    this.gridVisualization = null;
    this.currentCV = CONFIG.DEFAULT_CV;
    this.carbonDataset = soilCarbon;
  }
};

// =================================================================================
// === UTILITY FUNCTIONS - PRODUCTION VERSION =====================================
// =================================================================================

var Utils = {
  validateNumber: function(value, min, max, name) {
    var num = parseFloat(value);
    if (isNaN(num) || num < min || num > max) {
      return {
        valid: false,
        message: name + ' must be between ' + min + ' and ' + max
      };
    }
    return {valid: true, value: num};
  },
  
  formatNumber: function(num, decimals) {
    decimals = decimals !== undefined ? decimals : 0;
    if (num === null || num === undefined) return '0';
    return num.toFixed(decimals);
  },
  
  /**
   * FIXED: Creates systematic grid using proper indexing
   */
  createSystematicGrid: function(polygon, nPoints, seed) {
    var polygonArea = polygon.area({'maxError': CONFIG.MAX_ERROR});
    var cellSizeSquared = ee.Number(polygonArea).divide(nPoints);
    var cellSize = cellSizeSquared.sqrt();
    
    var proj = ee.Projection(CONFIG.EQUAL_AREA_PROJECTION).atScale(cellSize);
    var offsetProj = this.applyRandomOffset(proj, seed);
    var latlon = ee.Image.pixelLonLat().reproject(offsetProj);
    
    var coords = latlon.select(['longitude', 'latitude'])
      .reduceRegion({
        reducer: ee.Reducer.toList(),
        geometry: polygon,
        scale: offsetProj.nominalScale(),
        maxPixels: CONFIG.MAX_PIXELS,
        tileScale: 4
      });
    
    var pointList = ee.List(coords.get('longitude')).zip(ee.List(coords.get('latitude')));
    var pointCount = pointList.size();
    var indices = ee.List.sequence(0, pointCount.subtract(1));
    
    var feats = indices.map(function(idx) {
      var point = pointList.get(idx);
      return ee.Feature(ee.Geometry.Point(point), {'grid_id': idx});
    });
    
    return ee.FeatureCollection(feats);
  },
  
  applyRandomOffset: function(projection, seed) {
    var offsetFeature = ee.FeatureCollection([ee.Feature(null, null)])
      .randomColumn('x', seed)
      .randomColumn('y', seed + 1)
      .first();
    return projection.translate(offsetFeature.get('x'), offsetFeature.get('y'));
  },
  
  createGridVisualization: function(polygon, nPoints, seed) {
    var polygonArea = polygon.area({'maxError': CONFIG.MAX_ERROR});
    var cellSize = ee.Number(polygonArea).divide(nPoints).sqrt();
    
    var proj = ee.Projection(CONFIG.EQUAL_AREA_PROJECTION).atScale(cellSize);
    var offsetProj = this.applyRandomOffset(proj, seed);
    
    var cells = ee.Image.pixelCoordinates(offsetProj.scale(2, 2));
    var grid = cells.subtract(cells.round()).zeroCrossing().reduce('sum').selfMask();
    
    return grid.clip(polygon);
  },
  
  /**
   * FIXED: Projection-based square generation for accuracy at high latitudes
   * Uses EPSG:3978 to ensure true squares regardless of latitude
   */
  createSquareSimple: function(point, area_m2) {
    var side = Math.sqrt(area_m2);
    var halfSide = side / 2;
    
    // Transform to equal-area projection for accurate square generation
    var pointGeom = point.geometry();
    var pointProj = pointGeom.transform(CONFIG.EQUAL_AREA_PROJECTION);
    
    // Buffer to create square side, then get bounds for perfect square
    var square = pointProj.buffer(halfSide, CONFIG.MAX_ERROR).bounds();
    
    // Transform back to WGS84 for export
    var squareWGS84 = square.transform('EPSG:4326');
    
    return ee.Feature(squareWGS84).set({
      'shape': 'square',
      'area_m2': area_m2,
      'method': 'projection_buffer'
    });
  },
  
  createCircle: function(point, area_m2) {
    var radius = Math.sqrt(area_m2 / Math.PI);
    var buffer = point.geometry().buffer(radius, CONFIG.MAX_ERROR);
    return ee.Feature(buffer).set({
      'shape': 'circle',
      'area_m2': area_m2
    });
  },
  
  randomPointsInPolygon: function(polygon, count, seed) {
    return ee.FeatureCollection.randomPoints({
      region: polygon.geometry(),
      points: count,
      seed: seed,
      maxError: CONFIG.MAX_ERROR
    });
  },
  
  calculateCarbonStats: function(region, carbonImage) {
    if (!carbonImage) {
      return ee.Dictionary({
        'error': 'No carbon dataset provided',
        'mean': null,
        'stdDev': null
      });
    }
    
    var stats = carbonImage.reduceRegion({
      reducer: ee.Reducer.mean()
        .combine(ee.Reducer.stdDev(), '', true)
        .combine(ee.Reducer.minMax(), '', true)
        .combine(ee.Reducer.count(), '', true),
      geometry: region,
      scale: CONFIG.CARBON_SCALE,
      maxPixels: CONFIG.MAX_PIXELS,
      tileScale: 4
    });
    
    return ee.Dictionary({
      carbon_mean: stats.get('b1_mean'),
      carbon_stdDev: stats.get('b1_stdDev'),
      carbon_min: stats.get('b1_min'),
      carbon_max: stats.get('b1_max'),
      carbon_count: stats.get('b1_count')
    });
  },
  
  /**
   * Polynomial approximation for z-score (kept as requested)
   */
  calculateZScore: function(confidencePercent) {
    var confidence = ee.Number(confidencePercent);
    var alpha = ee.Number(1).subtract(confidence.divide(100));
    
    var zScore = ee.Number(2.41)
      .add(ee.Number(-10.9).multiply(alpha))
      .add(ee.Number(37.7).multiply(alpha.pow(2)))
      .subtract(ee.Number(57.9).multiply(alpha.pow(3)));
    
    return zScore;
  },
  
  calculateSampleSizeFromCV: function(cv, confidencePercent, marginOfErrorPercent) {
    var z = Utils.calculateZScore(confidencePercent);
    var cvDecimal = ee.Number(cv);
    var meDecimal = ee.Number(marginOfErrorPercent).divide(100);
    
    var n = z.multiply(cvDecimal).divide(meDecimal).pow(2);
    
    return ee.Dictionary({
      sample_size: n,
      z_score: z,
      cv_used: cvDecimal.multiply(100),
      method: 'cv_slider'
    });
  },
  
  /**
   * FIXED: Proper FPC using count of sampling units, not area
   * N = potential number of composites that could fit in AOI
   */
  calculateSampleSizeFromStats: function(stats, confidencePercent, marginOfErrorPercent, aoiArea, compositeArea) {
    var stdDev = ee.Number(stats.get('carbon_stdDev'));
    var mean = ee.Number(stats.get('carbon_mean'));
    
    var z = Utils.calculateZScore(confidencePercent);
    var E = mean.multiply(ee.Number(marginOfErrorPercent)).divide(100);
    var n0 = z.pow(2).multiply(stdDev.pow(2)).divide(E.pow(2));
    
    // FIXED: Population = number of potential sampling units (composites)
    // Not area in m², but count of units
    var N = ee.Number(aoiArea).divide(compositeArea);
    
    // Finite population correction
    var n = n0.divide(ee.Number(1).add(n0.subtract(1).divide(N)));
    
    return ee.Dictionary({
      sample_size: n,
      z_score: z,
      std_dev: stdDev,
      mean: mean,
      margin_of_error_absolute: E,
      population_size: N,
      n0_infinite: n0,
      cv_percent: stdDev.divide(mean).multiply(100),
      fpc_applied: n.lt(n0),
      method: 'data_driven'
    });
  }
};

// =================================================================================
// === USER INTERFACE SETUP =======================================================
// =================================================================================

ui.root.clear();
var map = ui.Map();
var panel = ui.Panel({style: STYLES.PANEL});
var splitPanel = ui.SplitPanel(panel, map, 'horizontal', false);
ui.root.add(splitPanel);
map.setCenter(-95, 55, 4);

panel.add(ui.Label('Blue Carbon Sampling Toolkit', STYLES.TITLE));
panel.add(ui.Label('Composite Sampling in Canadian Coastal Ecosystem', STYLES.SUBTITLE));
panel.add(ui.Label(
  'Generate a composite sampling design for Canadian blue carbon ecosystems (seagrass, salt marshes, eelgrass). ' +
  'HR cores centered within paired and unpaired composites.',
  STYLES.PARAGRAPH
));
panel.add(STYLES.HR);

// --- Step 1: Define AOI ---
panel.add(ui.Label('Step 1: Define Sampling Area', STYLES.HEADER));

var assetIdBox = ui.Textbox({
  placeholder: 'e.g., users/your_name/your_blue_carbon_site',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

var assetPanel = ui.Panel(
  [ui.Label('Enter GEE Asset Path:', STYLES.INSTRUCTION), assetIdBox],
  null,
  {shown: false}
);

var aoiSelection = ui.Select({
  items: ['Draw a polygon', 'Use a GEE Asset'],
  value: 'Draw a polygon',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    assetPanel.style().set('shown', value === 'Use a GEE Asset');
    map.drawingTools().setShown(value === 'Draw a polygon');
  }
});

panel.add(aoiSelection);
panel.add(assetPanel);
panel.add(ui.Label('► Draw your coastal area of interest or provide asset path', STYLES.INSTRUCTION));

// =================================================================================
// === STEP 1.5: SAMPLE SIZE CALCULATOR (CV SLIDER 0-200%) ========================
// =================================================================================

panel.add(ui.Label('Step 1.5: Calculate Sample Size', STYLES.HEADER));
panel.add(ui.Label(
  'Calculate sample size folliwng UNFCCC sample size tool. Use CV slider for quick estimates ' +
  'or carbon dataset to inform your calculation.',
  STYLES.INSTRUCTION
));

var carbonDatasetBox = ui.Textbox({
  placeholder: 'Leave blank to use default Canadian soil carbon',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

panel.add(ui.Label('Alternative Carbon Dataset (optional):', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(carbonDatasetBox);
panel.add(ui.Label(
  '► Default: Canadian soil carbon (projects/sat-io/.../sc). Override only if needed.',
  STYLES.INFO
));

// UPDATED: CV Slider now 0-200%
var cvSlider = ui.Slider({
  min: 0, max: 2.0, value: CONFIG.DEFAULT_CV, step: 0.5,
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(v) { 
    AppState.currentCV = v; 
    cvValueLabel.setValue('CV = ' + (v*100).toFixed(0) + '%'); 
  }
});
var cvValueLabel = ui.Label('CV = 50%', {fontSize: '12px', margin: '0 8px', fontWeight: 'bold'});

panel.add(ui.Label('Coefficient of Variation (CV) - Range 0-200%:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(cvSlider);
panel.add(cvValueLabel);
panel.add(ui.Label(
  '► Adjust CV slider (0-200%). Higher CV = more samples needed. Typical range 10-50%.',
  STYLES.INFO
));

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
  ui.Label('Confidence Level (%):', {width: '150px'}), 
  confidenceBox
], ui.Panel.Layout.flow('horizontal')));

panel.add(ui.Panel([
  ui.Label('Margin of Error (%):', {width: '150px'}), 
  marginOfErrorBox
], ui.Panel.Layout.flow('horizontal')));

panel.add(ui.Label(
  '► Higher confidence and lower margin of error require more samples',
  STYLES.INSTRUCTION
));

var calculateSampleSizeButton = ui.Button({
  label: '📊 Calculate Required Sample Size',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: calculateAndShowSampleSize
});
panel.add(calculateSampleSizeButton);

var sampleSizeResultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(sampleSizeResultsPanel);

// --- Step 2: Configure Sampling Design ---
panel.add(ui.Label('Step 2: Configure Sampling Design', STYLES.HEADER));

var strategySelect = ui.Select({
  items: ['Systematic Grid', 'Random'],
  value: 'Systematic Grid',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

panel.add(ui.Label('Sampling Strategy:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(strategySelect);
panel.add(ui.Label(
  '► Systematic Grid: Even spacing using Canada Lambert projection (EPSG:3978)',
  STYLES.INFO
));
panel.add(ui.Label(
  '► Strategy applies to unpaired composites only. Paired are centered on HR cores.',
  STYLES.INFO
));

var shapeSelect = ui.Select({
  items: ['Square', 'Circle'],
  value: 'Circle',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

panel.add(ui.Label('Composite Shape:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(shapeSelect);
panel.add(ui.Label(
  '► Circle recommended for sediment cores; Square for plot-based sampling',
  STYLES.INFO
));

var hrCoresBox = ui.Textbox({
  placeholder: 'Number of HR cores',
  value: CONFIG.DEFAULT_HR_CORES.toString(),
  style: {width: '80px', margin: '0 8px'}
});

var compositesBox = ui.Textbox({
  placeholder: 'Total composites',
  value: CONFIG.DEFAULT_COMPOSITES_PER_STRATUM.toString(),
  style: {width: '80px', margin: '0 8px'}
});

var compositeAreaBox = ui.Textbox({
  placeholder: 'Area in m²',
  value: CONFIG.DEFAULT_COMPOSITE_AREA.toString(),
  style: {width: '80px', margin: '0 8px'}
});

var subsamplesBox = ui.Textbox({
  placeholder: 'Count',
  value: CONFIG.DEFAULT_SUBSAMPLES.toString(),
  style: {width: '80px', margin: '0 8px'}
});

var pairingFractionBox = ui.Textbox({
  placeholder: '0-1',
  value: CONFIG.DEFAULT_PAIRING_FRACTION.toString(),
  style: {width: '80px', margin: '0 8px'}
});

panel.add(ui.Label('HR Soil Cores (high detail):', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(ui.Panel([ui.Label('Number of cores:', {width: '150px'}), hrCoresBox], 
  ui.Panel.Layout.flow('horizontal')));
panel.add(ui.Label(
  '► Each HR core will be at the center of a paired composite',
  STYLES.INFO
));

panel.add(ui.Label('Composite Samples:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(ui.Panel([ui.Label('Total composites:', {width: '150px'}), compositesBox], 
  ui.Panel.Layout.flow('horizontal')));
panel.add(ui.Panel([ui.Label('Area (m²):', {width: '150px'}), compositeAreaBox], 
  ui.Panel.Layout.flow('horizontal')));
panel.add(ui.Panel([ui.Label('Subsamples per composite:', {width: '150px'}), subsamplesBox], 
  ui.Panel.Layout.flow('horizontal')));

panel.add(ui.Label('Pairing Strategy:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(ui.Panel([ui.Label('Fraction to pair (0-1):', {width: '150px'}), pairingFractionBox], 
  ui.Panel.Layout.flow('horizontal')));
panel.add(ui.Label(
  '► e.g., 0.4 = 40% of composites paired (centered on HR cores), 60% unpaired.',
  STYLES.INFO
));

// --- Step 3: Generate Sampling Design ---
panel.add(ui.Label('Step 3: Generate Sampling Design', STYLES.HEADER));

var generateButton = ui.Button({
  label: 'Generate Sampling Locations',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: generateSamplingDesign
});
panel.add(generateButton);

var resultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(resultsPanel);

// --- Step 4: Export Results ---
panel.add(ui.Label('Step 4: Export Sampling Plan', STYLES.HEADER));

var exportFormatSelect = ui.Select({
  items: ['CSV', 'GeoJSON', 'KML', 'SHP'],
  value: 'CSV',
  style: {stretch: 'horizontal', margin: '0 8px'}
});
panel.add(ui.Label('Export Format:', {margin: '8px 8px 4px 8px', fontWeight: 'bold'}));
panel.add(exportFormatSelect);

var exportCompositesButton = ui.Button({
  label: '⬇️ Export Composite Polygons',
  style: {stretch: 'horizontal', margin: '4px 8px'},
  disabled: true
});

var exportSubsamplesButton = ui.Button({
  label: '⬇️ Export Subsample Points',
  style: {stretch: 'horizontal', margin: '4px 8px'},
  disabled: true
});

var exportHRCoresButton = ui.Button({
  label: '⬇️ Export HR Core Locations',
  style: {stretch: 'horizontal', margin: '4px 8px'},
  disabled: true
});

panel.add(exportCompositesButton);
panel.add(exportSubsamplesButton);
panel.add(exportHRCoresButton);

var downloadLinksPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(downloadLinksPanel);

var clearButton = ui.Button({
  label: 'Clear All & Start Over',
  style: {stretch: 'horizontal', margin: '8px'}
});
panel.add(clearButton);

// =================================================================================
// === SAMPLE SIZE CALCULATOR FUNCTION ============================================
// =================================================================================

function calculateAndShowSampleSize() {
  sampleSizeResultsPanel.clear();
  
  var aoi = getAoi();
  if (!aoi) {
    sampleSizeResultsPanel.add(ui.Label(
      '⚠️ Please define an area of interest first!', 
      STYLES.ERROR
    ));
    return;
  }
  
  var confVal = Utils.validateNumber(confidenceBox.getValue(), 80, 99.9, 'Confidence level');
  if (!confVal.valid) {
    sampleSizeResultsPanel.add(ui.Label(confVal.message, STYLES.ERROR));
    return;
  }
  
  var moeVal = Utils.validateNumber(marginOfErrorBox.getValue(), 1, 50, 'Margin of error');
  if (!moeVal.valid) {
    sampleSizeResultsPanel.add(ui.Label(moeVal.message, STYLES.ERROR));
    return;
  }
  
  var compositeAreaVal = Utils.validateNumber(compositeAreaBox.getValue(), 1, 10000, 'Composite area');
  if (!compositeAreaVal.valid) {
    compositeAreaVal = {value: CONFIG.DEFAULT_COMPOSITE_AREA};
  }
  
  sampleSizeResultsPanel.add(ui.Label('Calculating sample size...', {
    color: '#666',
    fontStyle: 'italic',
    margin: '8px'
  }));
  
  var carbonPath = carbonDatasetBox.getValue();
  if (carbonPath && carbonPath.trim() !== '') {
    try {
      AppState.carbonDataset = ee.Image(carbonPath);
    } catch (e) {
      sampleSizeResultsPanel.clear();
      sampleSizeResultsPanel.add(ui.Label(
        '⚠️ Error loading alternative carbon dataset: ' + e.message, 
        STYLES.ERROR
      ));
      return;
    }
  }
  
  // Calculate using CV slider
  Utils.calculateSampleSizeFromCV(
    AppState.currentCV,
    confVal.value,
    moeVal.value
  ).evaluate(function(cvResult, cvError) {
    if (cvError) {
      sampleSizeResultsPanel.clear();
      sampleSizeResultsPanel.add(ui.Label(
        '⚠️ Error in CV calculation: ' + cvError, 
        STYLES.ERROR
      ));
      return;
    }
    
    var cvSampleSize = Math.ceil(cvResult.sample_size);
    
    sampleSizeResultsPanel.clear();
    sampleSizeResultsPanel.add(ui.Label('Sample Size Calculation Results:', STYLES.SUBHEADER));
    
    sampleSizeResultsPanel.add(ui.Label(
      '📊 CV-Based Estimate: ' + cvSampleSize + ' samples',
      {fontSize: '14px', fontWeight: 'bold', color: '#00796B', margin: '8px'}
    ));
    
    sampleSizeResultsPanel.add(ui.Label(
      'Based on CV slider setting:',
      {fontSize: '12px', margin: '4px 8px', fontWeight: 'bold'}
    ));
    
    sampleSizeResultsPanel.add(ui.Label(
      '  • CV: ' + Utils.formatNumber(cvResult.cv_used, 1) + '%',
      {fontSize: '12px', margin: '2px 8px'}
    ));
    
    sampleSizeResultsPanel.add(ui.Label(
      '  • Z-score: ' + Utils.formatNumber(cvResult.z_score, 3),
      {fontSize: '12px', margin: '2px 8px'}
    ));
    
    sampleSizeResultsPanel.add(ui.Label(
      '  • Confidence: ' + confVal.value + '%',
      {fontSize: '12px', margin: '2px 8px'}
    ));
    
    sampleSizeResultsPanel.add(ui.Label(
      '  • Margin of Error: ±' + moeVal.value + '%',
      {fontSize: '12px', margin: '2px 8px'}
    ));
    
    var applyButtonCV = ui.Button({
      label: 'Apply CV Estimate (' + cvSampleSize + ')',
      style: {margin: '8px', backgroundColor: '#00796B'},
      onClick: function() {
        compositesBox.setValue(cvSampleSize.toString());
        sampleSizeResultsPanel.add(ui.Label(
          '✓ Applied ' + cvSampleSize + ' to composites field',
          STYLES.SUCCESS
        ));
      }
    });
    sampleSizeResultsPanel.add(applyButtonCV);
    
    // Calculate AOI area for FPC
    aoi.area(CONFIG.MAX_ERROR).evaluate(function(aoiArea, areaError) {
      if (areaError) {
        print('Could not calculate AOI area for FPC');
        return;
      }
      
      sampleSizeResultsPanel.add(ui.Label(''));
      sampleSizeResultsPanel.add(ui.Label('Calculating estimate...', {
        fontSize: '12px',
        fontStyle: 'italic',
        margin: '4px 8px',
        color: '#666'
      }));
      
      Utils.calculateCarbonStats(aoi, AppState.carbonDataset).evaluate(function(stats, statError) {
        if (statError || !stats.carbon_mean || !stats.carbon_stdDev) {
          var widgets = sampleSizeResultsPanel.widgets();
          sampleSizeResultsPanel.remove(widgets.get(widgets.length() - 1));
          
          sampleSizeResultsPanel.add(ui.Label(
            '⚠️ Calculation unavailable (no carbon data in AOI)',
            {fontSize: '12px', margin: '4px 8px', color: '#888'}
          ));
          return;
        }
        
        // FIXED: Pass AOI area and composite area for proper FPC
        Utils.calculateSampleSizeFromStats(
          ee.Dictionary(stats),
          confVal.value,
          moeVal.value,
          aoiArea,
          compositeAreaVal.value
        ).evaluate(function(dataResult, dataError) {
          var widgets = sampleSizeResultsPanel.widgets();
          sampleSizeResultsPanel.remove(widgets.get(widgets.length() - 1));
          
          if (dataError) {
            sampleSizeResultsPanel.add(ui.Label(
              '⚠️ Calculation error: ' + dataError,
              {fontSize: '12px', margin: '4px 8px', color: '#888'}
            ));
            return;
          }
          
          var dataSampleSize = Math.ceil(dataResult.sample_size);
          
          sampleSizeResultsPanel.add(ui.Label(
            'Estimate based on carbon data: ' + dataSampleSize + ' samples',
            {fontSize: '14px', fontWeight: 'bold', color: '#1565C0', margin: '8px'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            'Based on actual carbon variability in AOI:',
            {fontSize: '12px', margin: '4px 8px', fontWeight: 'bold'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            '  • Mean: ' + Utils.formatNumber(dataResult.mean, 2) + ' Mg C/ha',
            {fontSize: '12px', margin: '2px 8px'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            '  • Std Dev: ' + Utils.formatNumber(dataResult.std_dev, 2) + ' Mg C/ha',
            {fontSize: '12px', margin: '2px 8px'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            '  • Actual CV: ' + Utils.formatNumber(dataResult.cv_percent, 1) + '%',
            {fontSize: '12px', margin: '2px 8px'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            '  • Population (N): ' + Utils.formatNumber(dataResult.population_size, 0) + ' units',
            {fontSize: '12px', margin: '2px 8px'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            '  • FPC Applied: ' + (dataResult.fpc_applied ? 'Yes' : 'No'),
            {fontSize: '12px', margin: '2px 8px'}
          ));
          
          sampleSizeResultsPanel.add(ui.Label(
            '  • Margin of Error: ±' + Utils.formatNumber(dataResult.margin_of_error_absolute, 2) + ' Mg C/ha',
            {fontSize: '12px', margin: '2px 8px'}
          ));
          
          var applyButtonData = ui.Button({
            label: 'Apply Estimate (' + dataSampleSize + ')',
            style: {margin: '8px', backgroundColor: '#1565C0'},
            onClick: function() {
              compositesBox.setValue(dataSampleSize.toString());
              sampleSizeResultsPanel.add(ui.Label(
                '✓ Applied ' + dataSampleSize + ' to composites field',
                STYLES.SUCCESS
              ));
            }
          });
          sampleSizeResultsPanel.add(applyButtonData);
          
          print('═══════════════════════════════════════════════════════');
          print('📊 Sample Size Comparison');
          print('═══════════════════════════════════════════════════════');
          print('CV-Based (Slider):', cvSampleSize);
          print('Data-Driven (AOI):', dataSampleSize);
          print('Difference:', Math.abs(cvSampleSize - dataSampleSize));
          print('Population (N):', dataResult.population_size);
          print('FPC Applied:', dataResult.fpc_applied);
          print('Recommendation: Use data-driven if available for your specific AOI');
        });
      });
    });
  });
}

// =================================================================================
// === CORE SAMPLING FUNCTIONS ====================================================
// =================================================================================

function generateSamplingDesign() {
  resultsPanel.clear();
  downloadLinksPanel.clear();
  map.layers().reset();
  
  var loading = ui.Label('Generating sampling design...', {
    color: '#666',
    fontStyle: 'italic',
    margin: '8px'
  });
  resultsPanel.add(loading);
  
  AppState.currentAoi = getAoi();
  if (!AppState.currentAoi) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label('Please define an area of interest first!', STYLES.ERROR));
    return;
  }
  
  var validations = validateInputs();
  if (!validations.valid) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label(validations.message, STYLES.ERROR));
    return;
  }
  
  var params = validations.params;
  params.strategy = strategySelect.getValue();
  params.shape = shapeSelect.getValue();
  
  var requestedPaired = Math.floor(params.totalComposites * params.pairingFraction);
  params.numPaired = Math.min(requestedPaired, params.hrCores);
  params.numUnpaired = params.totalComposites - params.numPaired;
  
  if (requestedPaired > params.hrCores) {
    resultsPanel.add(ui.Label(
      '⚠️ Pairing fraction requested ' + requestedPaired + ' paired composites, ' +
      'but only ' + params.hrCores + ' HR cores available. Using ' + params.numPaired + ' paired.',
      STYLES.WARNING
    ));
  }
  
  if (params.pairingFraction > 0 && params.hrCores === 0) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label(
      '⚠️ Pairing fraction > 0 but no HR cores specified. Set HR cores > 0 or pairing fraction = 0.',
      STYLES.ERROR
    ));
    return;
  }
  
  map.centerObject(AppState.currentAoi, 10);
  map.addLayer(AppState.currentAoi, {color: '004d7a'}, 'Blue Carbon AOI');
  map.addLayer(AppState.carbonDataset.clip(AppState.currentAoi), scVis, 'Soil Carbon Context', false);
  
  var samplingRegion = AppState.currentAoi;
  
  generateHRCoresAndPairedComposites(samplingRegion, params);
}

function generateHRCoresAndPairedComposites(samplingRegion, params) {
  try {
    var hrCorePoints = ee.FeatureCollection.randomPoints({
      region: samplingRegion,
      points: params.hrCores,
      seed: CONFIG.RANDOM_SEED,
      maxError: CONFIG.MAX_ERROR
    });
    
    var hrCoresList = hrCorePoints.toList(params.hrCores);
    
    AppState.hrCores = ee.FeatureCollection(
      ee.List.sequence(0, ee.Number(params.hrCores).subtract(1)).map(function(i) {
        var pt = ee.Feature(hrCoresList.get(i));
        var coreId = ee.String('HR_').cat(ee.Number(i).format('%03d'));
        var hasPaired = ee.Number(i).lt(params.numPaired);
        return pt.set({
          'core_id': coreId,
          'type': 'hr_core',
          'has_paired_composite': hasPaired,
          'lon': pt.geometry().coordinates().get(0),
          'lat': pt.geometry().coordinates().get(1)
        });
      })
    );
    
    if (params.numPaired > 0) {
      var pairedComposites = ee.FeatureCollection(
        ee.List.sequence(0, ee.Number(params.numPaired).subtract(1)).map(function(i) {
          var hrCore = ee.Feature(hrCoresList.get(i));
          var coreId = ee.String('HR_').cat(ee.Number(i).format('%03d'));
          var compositeId = ee.String('COMP_P_').cat(ee.Number(i).format('%03d'));
          
          var polygon;
          if (params.shape === 'Circle') {
            polygon = Utils.createCircle(hrCore, params.compositeArea);
          } else {
            polygon = Utils.createSquareSimple(hrCore, params.compositeArea);
          }
          
          return polygon.set({
            'composite_id': compositeId,
            'type': 'composite',
            'paired': 1,
            'paired_core_id': coreId,
            'paired_dist_m': 0,
            'centroid_lon': hrCore.geometry().coordinates().get(0),
            'centroid_lat': hrCore.geometry().coordinates().get(1)
          });
        })
      );
      
      AppState.pairedComposites = pairedComposites;
    } else {
      AppState.pairedComposites = ee.FeatureCollection([]);
    }
    
    generateUnpairedComposites(samplingRegion, params);
    
  } catch (error) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label('Error generating HR cores: ' + error.message, STYLES.ERROR));
  }
}

function generateUnpairedComposites(samplingRegion, params) {
  try {
    if (params.numUnpaired <= 0) {
      AppState.unpairedComposites = ee.FeatureCollection([]);
      AppState.gridVisualization = null;
      combineCompositesAndGenerateSubsamples(params);
      return;
    }
    
    var unpairedPoints;
    var seedOffset = 100;
    
    if (params.strategy === 'Systematic Grid') {
      unpairedPoints = Utils.createSystematicGrid(
        samplingRegion,
        params.numUnpaired,
        CONFIG.RANDOM_SEED + seedOffset
      );
      
      AppState.gridVisualization = Utils.createGridVisualization(
        samplingRegion,
        params.numUnpaired,
        CONFIG.RANDOM_SEED + seedOffset
      );
      
    } else {
      unpairedPoints = ee.FeatureCollection.randomPoints({
        region: samplingRegion,
        points: params.numUnpaired,
        seed: CONFIG.RANDOM_SEED + seedOffset,
        maxError: CONFIG.MAX_ERROR
      });
      AppState.gridVisualization = null;
    }
    
    var pointsList = unpairedPoints.limit(params.numUnpaired).toList(params.numUnpaired);
    var actualCount = unpairedPoints.size();
    
    var unpairedComposites = ee.FeatureCollection(
      ee.List.sequence(0, actualCount.subtract(1)).map(function(i) {
        var pt = ee.Feature(pointsList.get(i));
        var compositeId = ee.String('COMP_U_').cat(ee.Number(i).format('%03d'));
        
        var polygon;
        if (params.shape === 'Circle') {
          polygon = Utils.createCircle(pt, params.compositeArea);
        } else {
          polygon = Utils.createSquareSimple(pt, params.compositeArea);
        }
        
        return polygon.set({
          'composite_id': compositeId,
          'type': 'composite',
          'paired': 0,
          'paired_core_id': null,
          'paired_dist_m': null,
          'centroid_lon': pt.geometry().coordinates().get(0),
          'centroid_lat': pt.geometry().coordinates().get(1)
        });
      })
    );
    
    AppState.unpairedComposites = unpairedComposites;
    combineCompositesAndGenerateSubsamples(params);
    
  } catch (error) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label('Error generating unpaired composites: ' + error.message, STYLES.ERROR));
  }
}

function combineCompositesAndGenerateSubsamples(params) {
  try {
    AppState.composites = AppState.pairedComposites.merge(AppState.unpairedComposites);
    generateSubsamples(params);
  } catch (error) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label('Error combining composites: ' + error.message, STYLES.ERROR));
  }
}

function generateSubsamples(params) {
  try {
    var subsampleSeed = CONFIG.RANDOM_SEED + 200;
    
    var subsampleCollections = AppState.composites.map(function(comp) {
      var compId = comp.get('composite_id');
      var subPts = Utils.randomPointsInPolygon(comp, params.subsamples, subsampleSeed);
      
      var subPtsList = subPts.toList(params.subsamples);
      
      return ee.FeatureCollection(
        ee.List.sequence(0, ee.Number(params.subsamples).subtract(1)).map(function(i) {
          var pt = ee.Feature(subPtsList.get(i));
          return pt.set({
            'composite_id': compId,
            'subsample_id': ee.String(compId).cat('_S').cat(ee.Number(i).format('%02d')),
            'type': 'subsample',
            'lon': pt.geometry().coordinates().get(0),
            'lat': pt.geometry().coordinates().get(1)
          });
        })
      );
    }).flatten();
    
    AppState.subsamples = ee.FeatureCollection(subsampleCollections);
    displayResults(params);
    
  } catch (error) {
    resultsPanel.clear();
    resultsPanel.add(ui.Label('Error generating subsamples: ' + error.message, STYLES.ERROR));
  }
}

function displayResults(params) {
  resultsPanel.clear();
  
  ee.Dictionary({
    totalComposites: AppState.composites.size(),
    pairedComposites: AppState.pairedComposites.size(),
    unpairedComposites: AppState.unpairedComposites.size(),
    totalSubsamples: AppState.subsamples.size(),
    totalHRCores: AppState.hrCores.size()
  }).evaluate(function(counts, error) {
    if (error) {
      resultsPanel.add(ui.Label('Error calculating statistics: ' + error, STYLES.ERROR));
      return;
    }
    
    resultsPanel.add(ui.Label('Blue Carbon Sampling Design Summary', STYLES.HEADER));
    
    resultsPanel.add(ui.Label(
      '✓ HR Cores: ' + counts.totalHRCores + 
      ' (' + counts.pairedComposites + ' with paired composites)',
      {fontSize: '13px', margin: '4px 8px', color: '#00796B'}
    ));
    
    resultsPanel.add(ui.Label(
      '✓ Total Composites: ' + counts.totalComposites + 
      ' (pairing fraction: ' + (params.pairingFraction * 100).toFixed(0) + '%)',
      {fontSize: '13px', margin: '4px 8px', color: '#00796B'}
    ));
    
    resultsPanel.add(ui.Label(
      '    • Paired (centered on HR cores): ' + counts.pairedComposites,
      {fontSize: '12px', margin: '2px 16px', color: '#1565C0'}
    ));
    
    resultsPanel.add(ui.Label(
      '    • Unpaired (' + params.strategy + '): ' + counts.unpairedComposites,
      {fontSize: '12px', margin: '2px 16px', color: '#6A1B9A'}
    ));
    
    resultsPanel.add(ui.Label(
      '✓ Subsamples: ' + counts.totalSubsamples + 
      ' (' + params.subsamples + ' per composite)',
      {fontSize: '13px', margin: '4px 8px', color: '#00796B'}
    ));
    
    resultsPanel.add(ui.Label(''));
    resultsPanel.add(ui.Label('Pairing Design:', STYLES.SUBHEADER));
    resultsPanel.add(ui.Label(
      counts.pairedComposites + ' of ' + counts.totalHRCores + 
      ' HR cores have paired composites centered on them.',
      {fontSize: '12px', margin: '4px 8px', fontStyle: 'italic'}
    ));
    
    if (counts.unpairedComposites > 0) {
      resultsPanel.add(ui.Label(
        counts.unpairedComposites + ' unpaired composites distributed via ' + 
        params.strategy + ' strategy.',
        {fontSize: '12px', margin: '4px 8px', fontStyle: 'italic'}
      ));
    }
    
    var pairedStyle = {color: '1565C0', fillColor: '1565C040'};
    var unpairedStyle = {color: '6A1B9A', fillColor: '6A1B9A40'};
    var hrStyle = {color: 'C62828', pointSize: 6};
    var subsampleStyle = {color: 'FFA000', pointSize: 2};
    var gridStyle = {color: '666666', width: 1};
    
    if (AppState.gridVisualization && params.strategy === 'Systematic Grid') {
      map.addLayer(AppState.gridVisualization, gridStyle, 'Systematic Grid (QA)', false);
    }
    
    map.addLayer(AppState.unpairedComposites, unpairedStyle, 'Unpaired Composites');
    map.addLayer(AppState.pairedComposites, pairedStyle, 'Paired Composites (centered on HR)');
    map.addLayer(AppState.hrCores, hrStyle, 'HR Core Locations');
    map.addLayer(AppState.subsamples, subsampleStyle, 'Subsample Points', false);
    
    resultsPanel.add(ui.Label(''));
    resultsPanel.add(ui.Label('Map Legend:', STYLES.SUBHEADER));
    resultsPanel.add(ui.Label('🔴 HR Cores (red points)', {fontSize: '11px', margin: '2px 8px'}));
    resultsPanel.add(ui.Label('🔵 Paired Composites (blue polygons)', {fontSize: '11px', margin: '2px 8px'}));
    resultsPanel.add(ui.Label('🟣 Unpaired Composites (purple polygons)', {fontSize: '11px', margin: '2px 8px'}));
    resultsPanel.add(ui.Label('🟡 Subsamples (yellow points, toggle on)', {fontSize: '11px', margin: '2px 8px'}));
    if (params.strategy === 'Systematic Grid') {
      resultsPanel.add(ui.Label('⬜ Systematic Grid (gray lines, toggle on for QA)', {fontSize: '11px', margin: '2px 8px'}));
    }
    
    exportCompositesButton.setDisabled(false);
    exportSubsamplesButton.setDisabled(false);
    exportHRCoresButton.setDisabled(false);
    
    resultsPanel.add(ui.Label('✓ Sampling design generated successfully', STYLES.SUCCESS));
    
    print('═══════════════════════════════════════════════════════');
    print('🌊 Canadian Blue Carbon Sampling Design Completed');
    print('═══════════════════════════════════════════════════════');
    print('VERSION: 2.0 - Production Ready');
    print('Strategy:', params.strategy);
    if (params.strategy === 'Systematic Grid') {
      print('  → Uses EPSG:3978 (Statistics Canada Lambert)');
      print('  → Optimized for Canadian coastal areas');
    }
    print('Shape:', params.shape);
    if (params.shape === 'Square') {
      print('  → Using projection-based square generation');
      print('  → Accurate at all latitudes including Arctic');
    }
    print('Pairing Fraction:', params.pairingFraction, '(' + (params.pairingFraction * 100) + '%)');
    print('Total Composites:', counts.totalComposites);
    print('  - Paired (centered on HR cores):', counts.pairedComposites);
    print('  - Unpaired (' + params.strategy + '):', counts.unpairedComposites);
    print('Subsamples:', counts.totalSubsamples);
    print('HR Cores:', counts.totalHRCores);
  });
}

// =================================================================================
// === HELPER FUNCTIONS ===========================================================
// =================================================================================

function getAoi() {
  var method = aoiSelection.getValue();
  
  if (method === 'Draw a polygon') {
    var layers = map.drawingTools().layers();
    if (layers.length() === 0) return null;
    var geometries = layers.get(0).geometries();
    if (geometries.length() === 0) return null;
    return layers.get(0).toGeometry();
  } else {
    var assetId = assetIdBox.getValue();
    if (!assetId || assetId.trim() === '') return null;
    try {
      var fc = ee.FeatureCollection(assetId);
      return fc.geometry();
    } catch (e) {
      alert('Failed to load asset: ' + e.message);
      return null;
    }
  }
}

function validateInputs() {
  var hrCoresVal = Utils.validateNumber(hrCoresBox.getValue(), 1, 100, 'HR Cores');
  if (!hrCoresVal.valid) return hrCoresVal;
  
  var compositesVal = Utils.validateNumber(compositesBox.getValue(), 1, 500, 'Total composites');
  if (!compositesVal.valid) return compositesVal;
  
  var areaVal = Utils.validateNumber(compositeAreaBox.getValue(), 1, 10000, 'Composite area');
  if (!areaVal.valid) return areaVal;
  
  var subsamplesVal = Utils.validateNumber(subsamplesBox.getValue(), 1, 50, 'Subsamples');
  if (!subsamplesVal.valid) return subsamplesVal;
  
  var pairingVal = Utils.validateNumber(pairingFractionBox.getValue(), 0, 1, 'Pairing fraction');
  if (!pairingVal.valid) return pairingVal;
  
  return {
    valid: true,
    params: {
      hrCores: hrCoresVal.value,
      totalComposites: compositesVal.value,
      compositeArea: areaVal.value,
      subsamples: subsamplesVal.value,
      pairingFraction: pairingVal.value
    }
  };
}

// =================================================================================
// === EXPORT FUNCTIONS ===========================================================
// =================================================================================

exportCompositesButton.onClick(function() {
  if (!AppState.composites) {
    alert('Please generate sampling design first.');
    return;
  }
  
  downloadLinksPanel.clear();
  var format = exportFormatSelect.getValue();
  
  var exportData = AppState.composites.map(function(f) {
    return f.set({
      'export_format': format,
      'export_date': ee.Date(Date.now()).format('YYYY-MM-dd'),
      'ecosystem_type': 'blue_carbon_canada',
      'version': '2.0'
    });
  });
  
  var downloadUrl = exportData.getDownloadURL({
    format: format === 'SHP' ? 'SHP' : format,
    filename: 'blue_carbon_composite_polygons_' + new Date().getTime()
  });
  
  var link = ui.Label({
    value: '⬇️ Download Composite Polygons (' + format + ')',
    style: {
      color: '#1565C0',
      textDecoration: 'underline',
      margin: '8px',
      fontSize: '13px',
      fontWeight: 'bold'
    },
    targetUrl: downloadUrl
  });
  
  downloadLinksPanel.add(link);
  print('✓ Composite polygons export link generated');
});

exportSubsamplesButton.onClick(function() {
  if (!AppState.subsamples) {
    alert('Please generate sampling design first.');
    return;
  }
  
  downloadLinksPanel.clear();
  var format = exportFormatSelect.getValue();
  
  var exportData = AppState.subsamples.map(function(f) {
    return f.set({
      'export_format': format,
      'export_date': ee.Date(Date.now()).format('YYYY-MM-dd'),
      'ecosystem_type': 'blue_carbon_canada',
      'version': '2.0'
    });
  });
  
  var downloadUrl = exportData.getDownloadURL({
    format: format === 'SHP' ? 'SHP' : format,
    filename: 'blue_carbon_subsample_points_' + new Date().getTime()
  });
  
  var link = ui.Label({
    value: '⬇️ Download Subsample Points (' + format + ')',
    style: {
      color: '#1565C0',
      textDecoration: 'underline',
      margin: '8px',
      fontSize: '13px',
      fontWeight: 'bold'
    },
    targetUrl: downloadUrl
  });
  
  downloadLinksPanel.add(link);
  print('✓ Subsample points export link generated');
});

exportHRCoresButton.onClick(function() {
  if (!AppState.hrCores) {
    alert('Please generate sampling design first.');
    return;
  }
  
  downloadLinksPanel.clear();
  var format = exportFormatSelect.getValue();
  
  var exportData = AppState.hrCores.map(function(f) {
    return f.set({
      'export_format': format,
      'export_date': ee.Date(Date.now()).format('YYYY-MM-dd'),
      'ecosystem_type': 'blue_carbon_canada',
      'version': '2.0'
    });
  });
  
  var downloadUrl = exportData.getDownloadURL({
    format: format === 'SHP' ? 'SHP' : format,
    filename: 'blue_carbon_hr_core_locations_' + new Date().getTime()
  });
  
  var link = ui.Label({
    value: '⬇️ Download HR Core Locations (' + format + ')',
    style: {
      color: '#1565C0',
      textDecoration: 'underline',
      margin: '8px',
      fontSize: '13px',
      fontWeight: 'bold'
    },
    targetUrl: downloadUrl
  });
  
  downloadLinksPanel.add(link);
  print('✓ HR core locations export link generated');
});

clearButton.onClick(function() {
  var confirmed = confirm('This will clear all generated sampling locations. Continue?');
  if (!confirmed) return;
  
  AppState.reset();
  map.layers().reset();
  map.drawingTools().clear();
  map.drawingTools().setShown(true);
  resultsPanel.clear();
  downloadLinksPanel.clear();
  sampleSizeResultsPanel.clear();
  
  exportCompositesButton.setDisabled(true);
  exportSubsamplesButton.setDisabled(true);
  exportHRCoresButton.setDisabled(true);
  
  hrCoresBox.setValue(CONFIG.DEFAULT_HR_CORES.toString());
  compositesBox.setValue(CONFIG.DEFAULT_COMPOSITES_PER_STRATUM.toString());
  compositeAreaBox.setValue(CONFIG.DEFAULT_COMPOSITE_AREA.toString());
  subsamplesBox.setValue(CONFIG.DEFAULT_SUBSAMPLES.toString());
  pairingFractionBox.setValue(CONFIG.DEFAULT_PAIRING_FRACTION.toString());
  confidenceBox.setValue(CONFIG.DEFAULT_CONFIDENCE.toString());
  marginOfErrorBox.setValue(CONFIG.DEFAULT_MARGIN_OF_ERROR.toString());
  strategySelect.setValue('Systematic Grid');
  shapeSelect.setValue('Circle');
  carbonDatasetBox.setValue('');
  cvSlider.setValue(CONFIG.DEFAULT_CV);
  cvValueLabel.setValue('CV = 15%');
  
  print('✓ Tool reset successfully');
});

// =================================================================================
// === INITIALIZE =================================================================
// =================================================================================

var drawingTools = map.drawingTools();
drawingTools.setShown(true);
drawingTools.setLinked(false);
drawingTools.setDrawModes(['polygon', 'rectangle']);
drawingTools.setShape('polygon');

map.setControlVisibility({
  all: false,
  layerList: true,
  zoomControl: true,
  scaleControl: true,
  mapTypeControl: true,
  fullscreenControl: false,
  drawingToolsControl: true
});

print('═══════════════════════════════════════════════════════');
print('🌊 Blue Carbon Sampling Toolkit - Canada Edition v2.0');
print('═══════════════════════════════════════════════════════');
print('');
print('VERSION 2.0 - PRODUCTION READY');
print('');
print('✓ CRITICAL FIXES APPLIED:');
print('  • Fixed Utils object syntax errors');
print('  • Fixed square generation for high latitude accuracy');
print('  • Fixed FPC population definition (count vs area)');
print('  • Extended CV slider range to 0-200%');
print('  • Improved grid indexing performance');
print('');
print('KEY FEATURES:');
print('  1. CV slider (0-200%) for quick sample size estimates');
print('  2. Data-driven calculation with proper FPC');
print('  3. Paired composites CENTERED on HR cores');
print('  4. Systematic grid using EPSG:3978');
print('  5. Projection-based square generation');
print('  6. Accurate at all Canadian latitudes');
print('');
print('PROJECTION:');
print('  • EPSG:3978 (Statistics Canada Lambert)');
print('  • Equal-area projection optimized for Canada');
print('  • Preserves area measurements for sampling');
print('');
print('ACCURACY IMPROVEMENTS:');
print('  • Squares use projection-based buffer method');
print('  • FPC uses proper population count (N)');
print('  • Grid indexing uses ee.List.sequence()');
print('');
print('Ready for Canadian blue carbon field work! 🍁🌊');
