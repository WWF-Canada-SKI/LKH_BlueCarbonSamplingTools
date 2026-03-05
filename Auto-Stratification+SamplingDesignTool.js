// =================================================================================
// === BLUE CARBON AUTO STRATIFIED RANDOM SAMPLING TOOL =================================
// =================================================================================

// =================================================================================
// === 1. CONFIGURATION ============================================================
// =================================================================================

var CONFIG = {
  // Analysis parameters
  ANALYSIS_SCALE: 250,           // 250m resolution for area calculations
  EMBEDDINGS_SCALE: 10,
  LANDCOVER_SCALE: 100,
  COVARIATE_SCALE: 30,
  MAX_PIXELS: 1e10,
  MAX_ERROR: 1,
  DEFAULT_SEED: 42,

  // Sample size constraints
  MIN_TOTAL_SAMPLES: 10,
  MAX_TOTAL_SAMPLES: 10000,
  MIN_SAMPLES_PER_STRATUM: 3,   

  // Statistical defaults
  DEFAULT_CONFIDENCE: 90,
  DEFAULT_MARGIN_OF_ERROR: 20,

  // Sampling parameters
  RANDOM_BUFFER_M: 50,           // Inward buffer to avoid edge effects
  BUFFER_RETRY_SEQUENCE: [50, 25, 10], // Adaptive buffer retry distances (m)

  // AOI size classification thresholds (hectares)
  AOI_SMALL_THRESHOLD: 50,        // Below 50 ha = small AOI
  AOI_LARGE_THRESHOLD: 50000,     // Above 50,000 ha = large AOI

  // Clustering parameters for remote-sensing covariates
  MIN_CLUSTERS: 2,
  MAX_CLUSTERS: 20,
  CLUSTER_RESTARTS: 3,
  TRAINING_PIXELS: 5000,          // Default fallback (overridden by adaptive scaling)
  TRAINING_PIXELS_PER_KM2: 2,     // Adaptive: 2 training pixels per km²
  MIN_TRAINING_PIXELS: 1000,      // Lower bound for adaptive scaling
  MAX_TRAINING_PIXELS: 50000,     // Upper bound to prevent memory overload

  // Covariate quality control parameters
  MAX_MISSING_FRACTION: 0.4,
  MIN_STD_DEV: 0.001,
  MAX_CORRELATION: 0.95,

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

var TOOLTIPS = {
  CONFIDENCE: 'How certain you want to be that the true value falls within your margin of error. 90% is standard for UNFCCC projects.',
  MARGIN_OF_ERROR: 'The acceptable range around your estimate. 20% means your result could be up to 20% above or below the true value.',
  PLOT_SIZE: 'The physical area of each sampling plot. Sediment cores are smallest (100 m\u00B2); vegetation plots are largest (400 m\u00B2).',
  VARIANCE_SOURCE: 'Where the carbon stock variability estimate comes from. IPCC Tier 1 defaults are global averages; Tier 2 uses your own data.',
  BAYESIAN_WEIGHT: 'How much your site data vs. global defaults influences the estimate. Larger sites rely more on site data.'
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
// === 2. DATA SOURCES =============================================================
// =================================================================================

var landcover = ee.Image('COPERNICUS/Landcover/100m/Proba-V-C3/Global/2019')
  .select('discrete_classification');

var copernicus100 = ee.Image('COPERNICUS/Landcover/100m/Proba-V-C3/Global/2019')
  .select('discrete_classification');
var dynamicWorld = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterDate('2022-01-01', '2022-12-31')
  .select('label')
  .mode();

var LANDCOVER_DATASETS = {
  'Copernicus 100m 2019': {
    image: copernicus100,
    classBand: 'discrete_classification',
    scale: 100,
    labels: {
      20: 'Shrubland', 30: 'Herbaceous vegetation', 40: 'Cultivated managed vegetation',
      50: 'Urban / built-up', 60: 'Bare / sparse vegetation', 70: 'Snow and ice',
      80: 'Permanent water bodies', 90: 'Herbaceous wetland', 100: 'Moss and lichen',
      111: 'Closed forest evergreen needle leaf', 112: 'Closed forest evergreen broad leaf',
      113: 'Closed forest deciduous needle leaf', 114: 'Closed forest deciduous broad leaf',
      115: 'Closed forest mixed', 116: 'Closed forest unknown', 121: 'Open forest evergreen needle leaf',
      122: 'Open forest evergreen broad leaf', 123: 'Open forest deciduous needle leaf',
      124: 'Open forest deciduous broad leaf', 125: 'Open forest mixed', 126: 'Open forest unknown',
      200: 'Oceans / seas'
    }
  },
  'Dynamic World 10m (mode 2022)': {
    image: dynamicWorld,
    classBand: 'label',
    scale: 10,
    labels: {
      0: 'Water', 1: 'Trees', 2: 'Grass', 3: 'Flooded vegetation', 4: 'Crops',
      5: 'Shrub and scrub', 6: 'Built area', 7: 'Bare ground', 8: 'Snow and ice'
    }
  }
};

// =================================================================================
// === 3. STATE MANAGEMENT =========================================================
// =================================================================================

var AppState = {
  currentAoi: null,
  allocationInfo: null,
  stratumCheckboxes: [],
  currentPoints: null,
  strataLayer: null,
  strataImage: null,
  carbonStats: null,
  currentCarbonType: null,
  calculatedSampleSize: null,
  stratificationMethod: null,
  numClusters: null,
  landcoverClasses: [],
  classSelectionWidgets: [],
  classRenameWidgets: {},
  activeStrataDefinitions: [],
  
  reset: function() {
    this.currentAoi = null;
    this.allocationInfo = null;
    this.stratumCheckboxes = [];
    this.currentPoints = null;
    this.strataLayer = null;
    this.strataImage = null;
    this.carbonStats = null;
    this.currentCarbonType = null;
    this.calculatedSampleSize = null;
    this.stratificationMethod = null;
    this.numClusters = null;
    this.landcoverClasses = [];
    this.classSelectionWidgets = [];
    this.classRenameWidgets = {};
    this.activeStrataDefinitions = [];
  }
};

// =================================================================================
// === 4. UTILITY FUNCTIONS ========================================================
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
  },

  /**
   * Classify AOI by size for adaptive behavior
   */
  classifyAoiSize: function(areaHa) {
    if (areaHa < CONFIG.AOI_SMALL_THRESHOLD) return 'small';
    if (areaHa > CONFIG.AOI_LARGE_THRESHOLD) return 'large';
    return 'medium';
  },

  /**
   * Check whether AOI is large enough for the requested sampling configuration
   */
  checkPlotFeasibility: function(areaHa, plotSizeHa, numStrata) {
    var totalPlots = areaHa / plotSizeHa;
    var minRequired = numStrata * CONFIG.MIN_SAMPLES_PER_STRATUM;
    return {
      feasible: totalPlots >= minRequired,
      totalPossiblePlots: Math.floor(totalPlots),
      minRequired: minRequired,
      ratio: totalPlots / minRequired
    };
  },

  /**
   * Compute sample size under low/medium/high variance scenarios
   * for sensitivity preview (display only, does not change allocation)
   */
  sensitivityPreview: function(strataInfo, confidence, marginOfError, plotSizeHa) {
    var scenarios = [
      {label: 'Low variance (optimistic)', factor: 0.5},
      {label: 'Medium variance (current)', factor: 1.0},
      {label: 'High variance (conservative)', factor: 1.5}
    ];
    var self = this;
    return scenarios.map(function(scenario) {
      var adjusted = strataInfo.map(function(s) {
        return {name: s.name, areaHa: s.areaHa, mean: s.mean, stdDev: s.stdDev * scenario.factor};
      });
      var totalAreaHa = 0;
      adjusted.forEach(function(s) { totalAreaHa += s.areaHa; });
      var N = totalAreaHa / plotSizeHa;
      var weightedMean = 0;
      adjusted.forEach(function(s) { weightedMean += (s.areaHa / totalAreaHa) * s.mean; });
      var E = weightedMean * (marginOfError / 100);
      var z = self.calculateZScore(confidence);
      var sumNiSigma = 0, sumNiSigmaSq = 0;
      adjusted.forEach(function(s) {
        var Ni = s.areaHa / plotSizeHa;
        sumNiSigma += Ni * s.stdDev;
        sumNiSigmaSq += Ni * Math.pow(s.stdDev, 2);
      });
      var num = Math.pow(sumNiSigma, 2);
      var den = Math.pow((N * E) / z, 2) + sumNiSigmaSq;
      var n = Math.ceil(num / den);
      n = Math.max(CONFIG.MIN_TOTAL_SAMPLES, Math.min(CONFIG.MAX_TOTAL_SAMPLES, n));
      return {label: scenario.label, sampleSize: n, factor: scenario.factor};
    });
  },

  /**
   * Scale training pixel count based on AOI area (Auto tool only)
   */
  calculateAdaptiveTrainingPixels: function(areaHa) {
    var areaKm2 = areaHa / 100;
    var pixels = Math.round(areaKm2 * CONFIG.TRAINING_PIXELS_PER_KM2);
    return Math.max(CONFIG.MIN_TRAINING_PIXELS, Math.min(CONFIG.MAX_TRAINING_PIXELS, pixels));
  },

  /**
   * Calculate sample size using UNFCCC Method I (Equation 5)
   * With Bayesian blending
   */
  calculateSampleSize: function(measuredMean, measuredStdDev, confidence, marginOfErrorPercent, areaHa, plotSizeHa, carbonType) {
    if (!measuredMean || measuredMean === 0 || !measuredStdDev || measuredStdDev === 0 || !areaHa || areaHa === 0) {
      return null;
    }
    
    // Apply Bayesian blending
    var blended = this.applyBayesianBlending(measuredMean, measuredStdDev, areaHa, carbonType);
    var mean = blended.mean;
    var stdDev = blended.stdDev;
    
    // Population size (UNFCCC Equation 1)
    var N = areaHa / plotSizeHa;
    
    // Allowable error
    var E = mean * (marginOfErrorPercent / 100);
    
    // Z-score
    var z = this.calculateZScore(confidence);
    
    // UNFCCC Method I (Equation 5)
    var numerator = Math.pow(N * stdDev, 2);
    var denomPart1 = Math.pow((N * E) / z, 2);
    var denomPart2 = N * Math.pow(stdDev, 2);
    var n = numerator / (denomPart1 + denomPart2);
    
    var cv = (stdDev / mean) * 100;
    var samplingFraction = (n / N) * 100;
    
    return {
      sampleSize: Math.ceil(n),
      zScore: z,
      marginOfErrorAbsolute: E,
      cv: cv,
      populationN: Math.floor(N),
      samplingFraction: samplingFraction,
      blendWeight: blended.weight,
      blendedMean: mean,
      blendedStdDev: stdDev,
      measuredMean: blended.measuredMean,
      measuredStdDev: blended.measuredStdDev
    };
  },
  
  /**
   * Calculate carbon statistics for a region
   */
  calculateCarbonStats: function(region, carbonType) {
    var carbonImage = carbonType === 'forest' ? forestCarbon : soilCarbon;
    
    var stats = carbonImage.reduceRegion({
      reducer: ee.Reducer.mean()
        .combine(ee.Reducer.stdDev(), '', true)
        .combine(ee.Reducer.count(), '', true)
        .combine(ee.Reducer.minMax(), '', true),
      geometry: region,
      scale: CONFIG.ANALYSIS_SCALE,
      maxPixels: CONFIG.MAX_PIXELS
    });
    
    var areaM2 = region.area({maxError: CONFIG.MAX_ERROR});
    return ee.Dictionary(stats).set('area_m2', areaM2);
  },
  
  /**
   * Improved rounding adjustment using largest remainder method
   */
  adjustRoundingErrors: function(allocations, totalTarget) {
    var withRemainders = allocations.map(function(s, i) {
      var exact = s.exactProportion * totalTarget;
      var floored = Math.floor(exact);
      return {
        index: i,
        floored: floored,
        remainder: exact - floored
      };
    });
    
    allocations.forEach(function(s, i) {
      s.points = Math.max(CONFIG.MIN_SAMPLES_PER_STRATUM, withRemainders[i].floored);
    });
    
    var currentSum = allocations.reduce(function(sum, s) {
      return sum + s.points;
    }, 0);
    var remaining = totalTarget - currentSum;
    
    withRemainders.sort(function(a, b) {
      return b.remainder - a.remainder;
    });
    
    for (var i = 0; i < remaining && i < withRemainders.length; i++) {
      allocations[withRemainders[i].index].points += 1;
    }
    
    return allocations;
  }
};

// =================================================================================
// === 5. STRATIFICATION METHODS ===================================================
// =================================================================================

var Stratifier = {
  
  getLandcoverConfig: function(datasetName) {
    return LANDCOVER_DATASETS[datasetName] || LANDCOVER_DATASETS['Copernicus 100m 2019'];
  },

  loadLandcoverClasses: function(aoi, datasetName, callback) {
    var dataset = this.getLandcoverConfig(datasetName);
    var classImage = dataset.image.rename('class').clip(aoi);

    var hist = classImage.reduceRegion({
      reducer: ee.Reducer.frequencyHistogram(),
      geometry: aoi,
      scale: dataset.scale,
      maxPixels: CONFIG.MAX_PIXELS,
      tileScale: 16
    });

    hist.evaluate(function(result, error) {
      if (error || !result || !result.class) {
        callback([], error || 'No classes found inside AOI');
        return;
      }

      var keys = Object.keys(result.class).map(function(k) { return parseInt(k, 10); })
        .sort(function(a, b) { return a - b; });

      var classes = keys.map(function(code) {
        return {
          code: code,
          pixels: result.class[code],
          name: dataset.labels[code] || ('Class ' + code)
        };
      });

      callback(classes, null);
    });
  },

  buildLandcoverStrata: function(aoi, datasetName, selectedClasses, renameMap) {
    var dataset = this.getLandcoverConfig(datasetName);
    var classImage = dataset.image.rename('class').clip(aoi);

    var fromCodes = selectedClasses.map(function(item) { return item.code; });
    var toCodes = selectedClasses.map(function(_, idx) { return idx; });

    var strata = classImage.remap(fromCodes, toCodes, -999).rename('strata');
    var strataImage = strata.updateMask(strata.neq(-999)).clip(aoi);

    var definitions = selectedClasses.map(function(item, idx) {
      var customName = renameMap[item.code];
      return {
        code: idx,
        sourceCode: item.code,
        name: (customName && customName.trim() !== '') ? customName.trim() : item.name
      };
    });

    return {
      image: strataImage,
      definitions: definitions
    };
  },

  buildCovariateStack: function(aoi) {
    var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(aoi)
      .filterDate('2022-01-01', '2023-12-31')
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
      .median()
      .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'], ['blue', 'green', 'red', 'nir', 'swir1', 'swir2']);

    var ndvi = s2.normalizedDifference(['nir', 'red']).rename('ndvi');
    var ndwi = s2.normalizedDifference(['green', 'nir']).rename('ndwi');
    var ndbi = s2.normalizedDifference(['swir1', 'nir']).rename('ndbi');

    var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
      .filterBounds(aoi)
      .filterDate('2022-01-01', '2023-12-31')
      .filter(ee.Filter.eq('instrumentMode', 'IW'))
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
      .median()
      .select(['VV', 'VH'], ['vv', 'vh']);

    var vvMinusVh = s1.select('vv').subtract(s1.select('vh')).rename('vv_vh_diff');

    var dem = ee.Image('USGS/SRTMGL1_003').rename('elevation');
    var slope = ee.Terrain.slope(dem).rename('slope');

    return s2.addBands([ndvi, ndwi, ndbi, s1, vvMinusVh, dem, slope])
      .reproject({crs: 'EPSG:4326', scale: CONFIG.COVARIATE_SCALE})
      .clip(aoi);
  },

  qualityControlBands: function(stack, aoi, callback) {
    var bandNames = stack.bandNames();
    var metrics = stack.reduceRegion({
      reducer: ee.Reducer.stdDev().combine(ee.Reducer.count(), '', true),
      geometry: aoi,
      scale: CONFIG.COVARIATE_SCALE,
      maxPixels: CONFIG.MAX_PIXELS,
      tileScale: 16
    });

    var self = this;
    ee.Dictionary({bandNames: bandNames, metrics: metrics}).evaluate(function(result, error) {
      if (error || !result) {
        callback([], {dropped: [], retained: []}, error || 'QC failed');
        return;
      }

      var bands = result.bandNames;
      var retained = [];
      var dropped = [];
      var totalPixels = 1;

      bands.forEach(function(band) {
        var count = result.metrics[band + '_count'] || 0;
        if (count > totalPixels) totalPixels = count;
      });

      bands.forEach(function(band) {
        var stdDev = result.metrics[band + '_stdDev'] || 0;
        var count = result.metrics[band + '_count'] || 0;
        var missingFraction = 1 - (count / totalPixels);

        if (missingFraction > CONFIG.MAX_MISSING_FRACTION) {
          dropped.push({band: band, reason: 'high_missing'});
        } else if (stdDev < CONFIG.MIN_STD_DEV) {
          dropped.push({band: band, reason: 'near_constant'});
        } else {
          retained.push(band);
        }
      });

      if (retained.length <= 1) {
        callback(retained, {retained: retained, dropped: dropped}, null);
        return;
      }

      var sample = stack.select(retained).sample({
        region: aoi,
        scale: CONFIG.COVARIATE_SCALE,
        numPixels: 1000,
        seed: CONFIG.DEFAULT_SEED,
        geometries: false
      });

      sample.limit(1000).evaluate(function(fc, sampleErr) {
        if (sampleErr || !fc || !fc.features || fc.features.length < 20) {
          callback(retained, {retained: retained, dropped: dropped}, null);
          return;
        }

        var selected = [];
        retained.forEach(function(band) {
          var canUse = true;
          for (var i = 0; i < selected.length; i++) {
            var corr = self.computeCorrelation(fc.features, band, selected[i]);
            if (Math.abs(corr) > CONFIG.MAX_CORRELATION) {
              canUse = false;
              dropped.push({band: band, reason: 'high_correlation_with_' + selected[i]});
              break;
            }
          }
          if (canUse) selected.push(band);
        });

        callback(selected, {retained: selected, dropped: dropped}, null);
      });
    });
  },

  computeCorrelation: function(features, aBand, bBand) {
    var values = [];
    for (var i = 0; i < features.length; i++) {
      var props = features[i].properties || {};
      if (props[aBand] === null || props[bBand] === null || props[aBand] === undefined || props[bBand] === undefined) continue;
      values.push([props[aBand], props[bBand]]);
    }
    if (values.length < 3) return 0;

    var n = values.length;
    var sumX = 0, sumY = 0;
    values.forEach(function(v) { sumX += v[0]; sumY += v[1]; });
    var meanX = sumX / n;
    var meanY = sumY / n;

    var num = 0, denX = 0, denY = 0;
    values.forEach(function(v) {
      var dx = v[0] - meanX;
      var dy = v[1] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    });

    return num / Math.sqrt((denX * denY) || 1);
  },

  createCovariateKMeansStrata: function(aoi, k, callback) {
    var covariateStack = this.buildCovariateStack(aoi);
    var self = this;

    this.qualityControlBands(covariateStack, aoi, function(validBands, qcSummary, qcError) {
      if (qcError) {
        callback(null, null, qcSummary, qcError);
        return;
      }

      if (!validBands || validBands.length === 0) {
        callback(null, null, qcSummary, 'No valid covariates remaining after QC');
        return;
      }

      var finalStack = covariateStack.select(validBands);

      // Adaptive training pixel scaling based on AOI area
      ee.Number(aoi.area({maxError: CONFIG.MAX_ERROR})).divide(10000).evaluate(function(aoiHa) {
        var trainingPixels = Utils.calculateAdaptiveTrainingPixels(aoiHa || 5000);
        print('Adaptive training pixels: ' + trainingPixels + ' (AOI: ' + Math.round(aoiHa || 0) + ' ha)');

        var trainingSample = finalStack.sample({
          region: aoi,
          scale: CONFIG.COVARIATE_SCALE,
          numPixels: trainingPixels,
          seed: CONFIG.DEFAULT_SEED,
          geometries: false
        });

        var clusterer = ee.Clusterer.wekaKMeans({
          nClusters: k,
          init: 1,
          canopies: true,
          seed: CONFIG.DEFAULT_SEED
        }).train(trainingSample);

        var classified = finalStack.cluster(clusterer).rename('strata').clip(aoi);
        var definitions = self.generateClusterNames(k).map(function(name, idx) {
          return {code: idx, sourceCode: idx, name: name};
        });

        callback(classified, definitions, qcSummary, null);
      });
    });
  },
  
  generateClusterPalette: function(numClusters) {
    var baseColors = [
      '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00',
      '#ffff33', '#a65628', '#f781bf', '#999999', '#66c2a5',
      '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f',
      '#e5c494', '#b3b3b3', '#1b9e77', '#d95f02', '#7570b3'
    ];
    return baseColors.slice(0, numClusters);
  },
  
  generateClusterNames: function(numClusters) {
    var names = [];
    for (var i = 0; i < numClusters; i++) {
      names.push('Cluster ' + (i + 1));
    }
    return names;
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
  'Stratified random sampling design for coastal blue carbon ecosystems with automatic stratification using land cover or remote sensing covariates.',
  STYLES.PARAGRAPH
));
panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'),
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 1: DEFINE AREA OF INTEREST ============================================
// =================================================================================

panel.add(ui.Label('Step 1: Define Area of Interest', STYLES.HEADER));

var aoiSelection = ui.Select({
  items: ['Draw a polygon', 'Upload/Use FeatureCollection asset'],
  value: 'Draw a polygon',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    assetPanel.style().set('shown', value === 'Upload/Use FeatureCollection asset');
    map.drawingTools().setShown(value === 'Draw a polygon');
  }
});

var assetIdBox = ui.Textbox({
  placeholder: 'e.g., users/your_name/your_asset',
  style: {stretch: 'horizontal', margin: '0 8px'}
});

var assetPanel = ui.Panel([
  ui.Label('Enter FeatureCollection/Shapefile Asset Path:', STYLES.INSTRUCTION),
  assetIdBox
], null, {shown: false});

panel.add(aoiSelection);
panel.add(assetPanel);
panel.add(ui.Label('► Draw an AOI polygon or provide an uploaded FeatureCollection/shapefile asset path.', STYLES.INSTRUCTION));

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'),
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 2: AUTOMATIC STRATIFICATION ============================================
// =================================================================================

panel.add(ui.Label('Step 2: Automatic Stratification Method', STYLES.HEADER));

var stratMethodSelect = ui.Select({
  items: [
    'Land Cover Based Stratification',
    'Remote Sensing + ML Stratification'
  ],
  value: 'Land Cover Based Stratification',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    landcoverPanel.style().set('shown', value.indexOf('Land Cover') !== -1);
    mlPanel.style().set('shown', value.indexOf('Remote Sensing') !== -1);
  }
});
panel.add(stratMethodSelect);

var landcoverDatasetSelect = ui.Select({
  items: Object.keys(LANDCOVER_DATASETS),
  value: 'Copernicus 100m 2019',
  style: {stretch: 'horizontal'}
});

var classListPanel = ui.Panel([], null, {margin: '4px 0 0 0'});

var loadClassesButton = ui.Button({
  label: 'Load Land Cover Classes in AOI',
  style: {stretch: 'horizontal', margin: '6px 0 0 0'},
  onClick: function() {
    classListPanel.clear();
    var aoi = getAoi();
    if (!aoi) {
      classListPanel.add(ui.Label('Define AOI first to load classes.', STYLES.WARNING));
      return;
    }

    classListPanel.add(ui.Label('Loading classes from selected dataset...', STYLES.INFO));
    Stratifier.loadLandcoverClasses(aoi, landcoverDatasetSelect.getValue(), function(classes, error) {
      classListPanel.clear();
      if (error || !classes || classes.length === 0) {
        classListPanel.add(ui.Label('Unable to detect classes: ' + (error || 'No valid classes in AOI'), STYLES.ERROR));
        return;
      }

      AppState.landcoverClasses = classes;
      AppState.classSelectionWidgets = [];
      AppState.classRenameWidgets = {};

      classListPanel.add(ui.Label('Select classes to include as strata and optionally rename labels.', STYLES.INSTRUCTION));
      classes.forEach(function(cls) {
        var checkbox = ui.Checkbox({label: cls.name + ' (code ' + cls.code + ')', value: true});
        var renameBox = ui.Textbox({
          placeholder: 'Optional custom name',
          style: {width: '190px', margin: '0 0 0 8px'}
        });
        var row = ui.Panel([checkbox, renameBox], ui.Panel.Layout.flow('horizontal'), {margin: '2px 0'});
        classListPanel.add(row);
        AppState.classSelectionWidgets.push({checkbox: checkbox, classInfo: cls});
        AppState.classRenameWidgets[cls.code] = renameBox;
      });
    });
  }
});

var landcoverPanel = ui.Panel([
  ui.Label('Use existing land cover maps, clip to AOI, then choose/rename classes as strata.', STYLES.INFO),
  ui.Label('Land cover dataset:', STYLES.INSTRUCTION),
  landcoverDatasetSelect,
  loadClassesButton,
  classListPanel
], null, {shown: true, margin: '4px 8px'});
panel.add(landcoverPanel);

var kClustersBox = ui.Textbox({value: '6', style: {width: '80px'}});
var clusterVizCheckbox = ui.Checkbox({label: 'Display clusters immediately after run', value: true});

var mlPanel = ui.Panel([
  ui.Label('Build a covariate stack (spectral indices, SAR, elevation), run QC, and apply k-means.', STYLES.INFO),
  ui.Panel([
    ui.Label('Number of strata (k):'),
    kClustersBox
  ], ui.Panel.Layout.flow('horizontal'), {margin: '4px 0'}),
  clusterVizCheckbox
], null, {shown: false, margin: '4px 8px'});
panel.add(mlPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'),
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 3: CALCULATE STRATIFIED SAMPLE SIZE ====================================
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
  ui.Label('How sure do you need to be? (%):', {width: '190px'}),
  confidenceBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));
panel.add(ui.Label(TOOLTIPS.CONFIDENCE, {fontSize: '10px', color: '#999', margin: '0 8px 4px 8px', fontStyle: 'italic'}));

panel.add(ui.Panel([
  ui.Label('Acceptable error range (%):', {width: '190px'}),
  marginOfErrorBox
], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));
panel.add(ui.Label(TOOLTIPS.MARGIN_OF_ERROR, {fontSize: '10px', color: '#999', margin: '0 8px 4px 8px', fontStyle: 'italic'}));

var plotTypeSelect = ui.Select({
  items: ['Sediment Core (100 m\u00B2)', 'Composite Plot (250 m\u00B2)',
          'Vegetation Plot (400 m\u00B2)', 'Custom'],
  value: 'Sediment Core (100 m\u00B2)',
  style: {stretch: 'horizontal', margin: '0 8px'},
  onChange: function(value) {
    customPlotSizeBox.style().set('shown', value === 'Custom');
  }
});

var customPlotSizeBox = ui.Textbox({
  placeholder: 'Enter plot size in ha (e.g., 0.01)',
  style: {stretch: 'horizontal', margin: '0 8px', shown: false}
});

panel.add(ui.Label('Sampling plot size:', STYLES.INSTRUCTION));
panel.add(plotTypeSelect);
panel.add(ui.Label(TOOLTIPS.PLOT_SIZE, {fontSize: '10px', color: '#999', margin: '0 8px 4px 8px', fontStyle: 'italic'}));
panel.add(customPlotSizeBox);

var calculateButton = ui.Button({
  label: '📊 Calculate Stratified Sample Size',
  style: {stretch: 'horizontal', margin: '8px'},
  onClick: runAnalysis
});
panel.add(calculateButton);

var resultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(resultsPanel);

var sampleSizeResultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(sampleSizeResultsPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'),
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 4: GENERATE STRATIFIED RANDOM POINTS ===================================
// =================================================================================

panel.add(ui.Label('Step 4: Generate Stratified Random Points', STYLES.HEADER));

var generateButton = ui.Button({
  label: '🎲 Generate Stratified Random Sample',
  style: {stretch: 'horizontal', margin: '8px'},
  disabled: true,
  onClick: generateStratifiedPoints
});
panel.add(generateButton);

var pointsResultsPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(pointsResultsPanel);

panel.add(ui.Panel(null, ui.Panel.Layout.flow('horizontal'),
  {border: '1px solid #E0E0E0', margin: '20px 0px'}));

// =================================================================================
// === STEP 5: EXPORT SAMPLING DESIGN ==============================================
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

// --- Legend Panel ---
var legendPanel = ui.Panel({style: {margin: '0 8px'}});
panel.add(ui.Label('Strata Legend', STYLES.HEADER));
panel.add(legendPanel);

// =================================================================================
// === 7. CORE FUNCTIONS ===========================================================
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
    try { return ee.FeatureCollection(assetId.trim()).geometry(); } catch (e) { return null; }
  }
}

function runAnalysis() {
  sampleSizeResultsPanel.clear();
  legendPanel.clear();
  map.layers().reset();

  AppState.currentAoi = getAoi();
  if (!AppState.currentAoi) {
    sampleSizeResultsPanel.add(ui.Label('⚠️ Please define an area of interest first!', STYLES.ERROR));
    return;
  }

  var confVal = Utils.validateNumber(confidenceBox.getValue(), 80, 99.9, 'Confidence level');
  var moeVal = Utils.validateNumber(marginOfErrorBox.getValue(), 1, 50, 'Margin of error');
  if (!confVal.valid) {
    sampleSizeResultsPanel.add(ui.Label(confVal.message, STYLES.ERROR));
    return;
  }
  if (!moeVal.valid) {
    sampleSizeResultsPanel.add(ui.Label(moeVal.message, STYLES.ERROR));
    return;
  }

  // Get plot size
  var plotType = plotTypeSelect.getValue();
  var plotSizeHa;

  if (!plotType) {
    sampleSizeResultsPanel.add(ui.Label('Please select a plot type', STYLES.ERROR));
    return;
  }

  if (plotType === 'Custom') {
    var customVal = Utils.validateNumber(customPlotSizeBox.getValue(), 0.001, 1, 'Plot size');
    if (!customVal.valid) {
      sampleSizeResultsPanel.add(ui.Label(customVal.message, STYLES.ERROR));
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
    plotSizeHa = CONFIG.PLOT_SIZES.sediment_core;
  }

  sampleSizeResultsPanel.add(ui.Label('⏳ Running automatic stratification and calculating sample size...', STYLES.INFO));

  map.centerObject(AppState.currentAoi, 10);
  map.addLayer(AppState.currentAoi, {color: 'E53935'}, 'AOI');

  // Non-blocking AOI size advisory
  ee.Number(AppState.currentAoi.area({maxError: CONFIG.MAX_ERROR})).divide(10000).evaluate(function(aoiHa) {
    if (!aoiHa) return;
    var aoiClass = Utils.classifyAoiSize(aoiHa);
    if (aoiClass === 'small') {
      sampleSizeResultsPanel.add(ui.Label(
        'Small AOI (' + Utils.formatNumber(aoiHa, 1) + ' ha): Edge effects and buffer reduction may impact point placement.',
        STYLES.WARNING));
    } else if (aoiClass === 'large') {
      sampleSizeResultsPanel.add(ui.Label(
        'Large AOI (' + Utils.formatNumber(aoiHa, 0) + ' ha): Processing may take several minutes. ' +
        'ML training pixel count has been scaled automatically.',
        STYLES.INFO));
    }
  });

  var stratMethod = stratMethodSelect.getValue();
  AppState.stratificationMethod = stratMethod;

  if (stratMethod.indexOf('Remote Sensing') !== -1) {
    var kValidation = Utils.validateNumber(kClustersBox.getValue(), CONFIG.MIN_CLUSTERS, CONFIG.MAX_CLUSTERS, 'Number of clusters (k)');
    if (!kValidation.valid) {
      sampleSizeResultsPanel.add(ui.Label(kValidation.message, STYLES.ERROR));
      return;
    }

    var k = Math.round(kValidation.value);
    sampleSizeResultsPanel.clear();
    sampleSizeResultsPanel.add(ui.Label('⏳ Running remote sensing covariate QC + k-means clustering...', STYLES.INFO));

    Stratifier.createCovariateKMeansStrata(AppState.currentAoi, k, function(strataImage, definitions, qcSummary, error) {
      if (error) {
        sampleSizeResultsPanel.clear();
        sampleSizeResultsPanel.add(ui.Label('⚠️ Error in ML stratification: ' + error, STYLES.ERROR));
        return;
      }

      AppState.strataImage = strataImage;
      AppState.numClusters = k;
      AppState.activeStrataDefinitions = definitions;

      if (qcSummary && qcSummary.dropped && qcSummary.dropped.length > 0) {
        sampleSizeResultsPanel.add(ui.Label('Covariates dropped by QC: ' + qcSummary.dropped.map(function(d) { return d.band + ' (' + d.reason + ')'; }).join(', '), STYLES.WARNING));
      }
      sampleSizeResultsPanel.add(ui.Label('Covariates retained: ' + (qcSummary.retained || []).join(', '), STYLES.INFO));

      if (clusterVizCheckbox.getValue()) {
        map.addLayer(AppState.strataImage, {
          min: 0,
          max: k - 1,
          palette: Stratifier.generateClusterPalette(k)
        }, 'ML Clusters (k=' + k + ')', false);
      }

      calculateStratifiedSampleSize(confVal.value, moeVal.value, plotSizeHa, k);
    });
  } else {
    if (!AppState.classSelectionWidgets || AppState.classSelectionWidgets.length === 0) {
      sampleSizeResultsPanel.add(ui.Label('⚠️ Load land cover classes first, then choose classes to include.', STYLES.ERROR));
      return;
    }

    var selectedClasses = AppState.classSelectionWidgets
      .filter(function(item) { return item.checkbox.getValue(); })
      .map(function(item) { return item.classInfo; });

    if (selectedClasses.length === 0) {
      sampleSizeResultsPanel.add(ui.Label('⚠️ Select at least one land cover class for stratification.', STYLES.ERROR));
      return;
    }

    var renameMap = {};
    selectedClasses.forEach(function(cls) {
      renameMap[cls.code] = AppState.classRenameWidgets[cls.code].getValue();
    });

    var strataOutput = Stratifier.buildLandcoverStrata(
      AppState.currentAoi,
      landcoverDatasetSelect.getValue(),
      selectedClasses,
      renameMap
    );

    AppState.strataImage = strataOutput.image;
    AppState.activeStrataDefinitions = strataOutput.definitions;
    AppState.numClusters = strataOutput.definitions.length;

    calculateStratifiedSampleSize(confVal.value, moeVal.value, plotSizeHa, null);
  }
}

/**
 * UNFCCC AR-AM-Tool-03 Stratified Sample Size Calculation
 *
 * Formula:
 * n_total = (Σ N_i * σ_i)² / ((N * E / t_val)² + Σ N_i * σ_i²)
 *
 * Then allocate proportionally by area:
 * n_i = n_total * (Area_i / Total_Area)
 */
function calculateStratifiedSampleSize(confidence, marginOfErrorPercent, plotSizeHa, numClusters) {

  // Show initial progress
  sampleSizeResultsPanel.add(ui.Label('⏳ Step 1/3: Calculating stratum areas...', STYLES.INFO));

  // Calculate area per stratum using grouped reducer
  var areaImage = ee.Image.pixelArea().divide(10000).rename('area_ha'); // Convert to hectares
  var combined = areaImage.addBands(AppState.strataImage.rename('strata'));

  var areaStats = combined.reduceRegion({
    reducer: ee.Reducer.sum().group({
      groupField: 1,
      groupName: 'strata_code'
    }),
    geometry: AppState.currentAoi,
    scale: CONFIG.ANALYSIS_SCALE,
    maxPixels: CONFIG.MAX_PIXELS,
    tileScale: 16
  });

  areaStats.evaluate(function(result, error) {
    sampleSizeResultsPanel.clear();

    if (error || !result || !result.groups || result.groups.length === 0) {
      sampleSizeResultsPanel.add(ui.Label('⚠️ Error calculating strata areas: ' + (error || 'No valid strata found'), STYLES.ERROR));
      return;
    }

    // Show progress
    sampleSizeResultsPanel.add(ui.Label('✓ Step 1/3: Stratum areas calculated', {fontSize: '12px', color: '#00796B', margin: '4px 8px'}));
    sampleSizeResultsPanel.add(ui.Label('⏳ Step 2/3: Computing sample size (iterative t-distribution)...', STYLES.INFO));

    if (error || !result || !result.groups || result.groups.length === 0) {
      sampleSizeResultsPanel.add(ui.Label('⚠️ Error calculating strata areas: ' + (error || 'No valid strata found'), STYLES.ERROR));
      return;
    }

    var groups = result.groups;

    // Use IPCC Tier 1 Generic Blue Carbon defaults for all strata
    var genericDefaults = CONFIG.TIER1_DEFAULTS['Generic-Blue-Carbon'];

    // Process each stratum
    var strataInfo = groups.map(function(g) {
      // The grouped reducer returns 'sum' for the area_ha band
      var areaHa = g.sum || 0;
      var stratumName = getStratumNameByCode(g.strata_code);

      // Apply defaults - in automatic mode, we use generic defaults
      return {
        code: g.strata_code,
        name: stratumName,
        areaHa: areaHa,
        mean: genericDefaults.mean,
        stdDev: genericDefaults.stdDev,
        N_i: areaHa / plotSizeHa
      };
    });

    var L = strataInfo.length;
    var totalAreaHa = 0;
    strataInfo.forEach(function(s) {
      totalAreaHa += s.areaHa;
    });

    var N = totalAreaHa / plotSizeHa; // Total population

    // Iterative calculation with t-distribution
    var n_prev = N;
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

    var E = weightedMean * (marginOfErrorPercent / 100); // Absolute error

    while (iterations < maxIterations) {
      var df = Math.max(1, n_prev - L);
      t_val = Utils.getTValue(confidence, df);

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

    // Round up to ensure adequate sample and keep inside tool bounds
    var n_total = Math.ceil(n_final);
    n_total = Math.max(CONFIG.MIN_TOTAL_SAMPLES, n_total);
    n_total = Math.min(CONFIG.MAX_TOTAL_SAMPLES, n_total);

    // Ensure feasible minimum allocation when many strata exist
    var requiredMinimum = L * CONFIG.MIN_SAMPLES_PER_STRATUM;
    if (n_total < requiredMinimum) {
      n_total = requiredMinimum;
    }

    // Allocate samples by area with robust largest-remainder balancing
    strataInfo.forEach(function(s) {
      var proportion = s.areaHa / totalAreaHa;
      var exact = n_total * proportion;
      s.points = Math.floor(exact);
      s._remainder = exact - s.points;
    });

    // Apply per-stratum minimum first
    strataInfo.forEach(function(s) {
      s.points = Math.max(CONFIG.MIN_SAMPLES_PER_STRATUM, s.points);
    });

    // Reconcile any drift from target total while respecting minimums
    var assigned = strataInfo.reduce(function(sum, s) { return sum + s.points; }, 0);
    var diff = n_total - assigned;

    if (diff > 0) {
      strataInfo.sort(function(a, b) { return b._remainder - a._remainder; });
      for (var addIdx = 0; addIdx < diff; addIdx++) {
        strataInfo[addIdx % L].points++;
      }
    } else if (diff < 0) {
      strataInfo.sort(function(a, b) { return a._remainder - b._remainder; });
      var removable = -diff;
      var iter = 0;
      while (removable > 0 && iter < (L * CONFIG.MAX_TOTAL_SAMPLES)) {
        var idx = iter % L;
        if (strataInfo[idx].points > CONFIG.MIN_SAMPLES_PER_STRATUM) {
          strataInfo[idx].points--;
          removable--;
        }
        iter++;
      }
    }

    AppState.allocationInfo = strataInfo;
    AppState.calculatedSampleSize = n_total;

    // Display results
    sampleSizeResultsPanel.clear();
    sampleSizeResultsPanel.add(ui.Label('✓ Step 2/3: Sample size computed', {fontSize: '12px', color: '#00796B', margin: '4px 8px'}));
    sampleSizeResultsPanel.add(ui.Label('✓ Step 3/3: Allocation complete', {fontSize: '12px', color: '#00796B', margin: '4px 8px'}));
    sampleSizeResultsPanel.add(ui.Label(''));
    sampleSizeResultsPanel.add(ui.Label('✓ Stratified Sample Size Calculated', STYLES.SUCCESS));

    var summaryPanel = ui.Panel({
      style: {
        border: '2px solid #004d7a',
        padding: '12px',
        margin: '8px 0',
        backgroundColor: '#E3F2FD'
      }
    });

    summaryPanel.add(ui.Label('Total Sample Size: ' + n_total + ' plots', {
      fontSize: '20px', fontWeight: 'bold', color: '#004d7a', margin: '4px 0'
    }));

    summaryPanel.add(ui.Label('Confidence: ' + confidence + '% | Error: ±' + marginOfErrorPercent + '%', {
      fontSize: '11px', color: '#666'
    }));
    summaryPanel.add(ui.Label('t-value (df=' + Math.max(1, n_total - L) + '): ' + t_val.toFixed(3), {
      fontSize: '11px', color: '#666'
    }));
    summaryPanel.add(ui.Label('Margin of Error: ±' + E.toFixed(3) + ' kg/m²', {
      fontSize: '11px', color: '#666'
    }));
    summaryPanel.add(ui.Label('Iterations: ' + (iterations + 1) + ' (converged)', {
      fontSize: '11px', color: '#666'
    }));
    summaryPanel.add(ui.Label('Plot Size: ' + plotSizeHa + ' ha (' + (plotSizeHa * 10000) + ' m²)', {
      fontSize: '11px', color: '#666'
    }));

    sampleSizeResultsPanel.add(summaryPanel);

    // Allocation table
    sampleSizeResultsPanel.add(ui.Label('Sample Distribution by Ecosystem Zone', STYLES.SUBHEADER));

    var allocHeaderPanel = ui.Panel([
      ui.Label('Stratum', {fontWeight: 'bold', width: '140px'}),
      ui.Label('Plots', {fontWeight: 'bold', width: '60px'}),
      ui.Label('%', {fontWeight: 'bold', width: '50px'}),
      ui.Label('σ', {fontWeight: 'bold', width: '60px'})
    ], ui.Panel.Layout.flow('horizontal'), {margin: '8px 0 4px 0'});
    sampleSizeResultsPanel.add(allocHeaderPanel);

    strataInfo.forEach(function(s) {
      var pct = ((s.points / n_total) * 100).toFixed(1);

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

    // Over-confidence guardrail (Auto always uses IPCC defaults)
    sampleSizeResultsPanel.add(ui.Panel([
      ui.Label('Note: Variance is estimated from IPCC Tier 1 global averages (not site-specific measurements). ' +
        'The actual required sample size may differ. A pilot study can improve this estimate.',
        {fontSize: '11px', color: '#E65100', margin: '8px', backgroundColor: '#FFF3E0', padding: '8px'})
    ]));

    // Feasibility warning for extreme settings
    if (confidence > 97 && marginOfErrorPercent < 5) {
      sampleSizeResultsPanel.add(ui.Panel([
        ui.Label('These settings (high confidence + low error) may produce impractically large sample sizes. ' +
          'Consider relaxing one or both parameters.',
          {fontSize: '11px', color: '#D32F2F', margin: '8px', backgroundColor: '#FFEBEE', padding: '8px'})
      ]));
    }

    // Assumptions summary
    sampleSizeResultsPanel.add(ui.Label('Assumptions Summary', STYLES.SUBHEADER));
    var assumptionsPanel = ui.Panel({
      style: {border: '1px solid #E0E0E0', padding: '8px', margin: '4px 0', backgroundColor: '#FAFAFA'}
    });
    assumptionsPanel.add(ui.Label('Confidence: ' + confidence + '% - ' + TOOLTIPS.CONFIDENCE, {fontSize: '10px', margin: '2px 0'}));
    assumptionsPanel.add(ui.Label('Error: \u00B1' + marginOfErrorPercent + '% - ' + TOOLTIPS.MARGIN_OF_ERROR, {fontSize: '10px', margin: '2px 0'}));
    assumptionsPanel.add(ui.Label('Variance source: All IPCC Tier 1 generic defaults (global averages)', {fontSize: '10px', margin: '2px 0'}));
    sampleSizeResultsPanel.add(assumptionsPanel);

    // Sensitivity preview (what-if analysis)
    var scenarioStrata = strataInfo.map(function(s) {
      return {name: s.name, areaHa: s.areaHa, mean: s.mean, stdDev: s.stdDev};
    });
    var scenarios = Utils.sensitivityPreview(scenarioStrata, confidence, marginOfErrorPercent, plotSizeHa);
    sampleSizeResultsPanel.add(ui.Label('What-If: Variance Sensitivity', STYLES.SUBHEADER));
    scenarios.forEach(function(sc) {
      var marker = sc.factor === 1.0 ? ' << current' : '';
      sampleSizeResultsPanel.add(ui.Label(
        sc.label + ': ' + sc.sampleSize + ' plots' + marker,
        {fontSize: '11px', margin: '2px 8px', fontWeight: sc.factor === 1.0 ? 'bold' : 'normal'}
      ));
    });
    sampleSizeResultsPanel.add(ui.Label(
      'Shows how sample size changes if actual variance differs from assumed values. This does not affect your allocation.',
      {fontSize: '10px', color: '#888', fontStyle: 'italic', margin: '4px 8px'}
    ));

    // Create legend
    createLegend(numClusters);

    // Add Strata Layer to map
    var strataCount = AppState.activeStrataDefinitions.length || numClusters || 1;
    var palette = Stratifier.generateClusterPalette(strataCount);
    map.addLayer(AppState.strataImage, {min: 0, max: strataCount - 1, palette: palette}, 'Strata');

    generateButton.setDisabled(false);

    // Console output
    print('═══════════════════════════════════════════════════════');
    print('🌊 STRATIFIED SAMPLE SIZE CALCULATION');
    print('═══════════════════════════════════════════════════════');
    print('Method: UNFCCC AR-AM-Tool-03 (Stratified - Automatic)');
    print('Total sample size:', n_total);
    print('Number of strata:', L);
    print('Confidence:', confidence + '%');
    print('Margin of error:', marginOfErrorPercent + '%');
    print('t-value (df=' + Math.max(1, n_total - L) + '):', t_val.toFixed(3));
    print('Convergence iterations:', iterations + 1);
    print('---');
    print('ALLOCATION BY STRATUM:');
    strataInfo.forEach(function(s) {
      print('  • ' + s.name + ': ' + s.points + ' plots (' +
            ((s.points / n_total) * 100).toFixed(1) + '%)');
    });
    print('═══════════════════════════════════════════════════════');
  });
}

function getStratumNameByCode(code) {
  if (!AppState.activeStrataDefinitions || AppState.activeStrataDefinitions.length === 0) {
    return 'Stratum ' + code;
  }
  for (var i = 0; i < AppState.activeStrataDefinitions.length; i++) {
    if (AppState.activeStrataDefinitions[i].code === code) return AppState.activeStrataDefinitions[i].name;
  }
  return 'Stratum ' + code;
}

/**
 * Generate Stratified Random Sample Points
 *
 * Converts raster strata to vector polygons, then generates truly random points
 * within each stratum using ee.FeatureCollection.randomPoints().
 *
 * Process:
 * 1. Convert raster strata image to vector polygons per stratum
 * 2. For each stratum, use randomPoints() to generate truly random points
 * 3. Randomness is controlled by CONFIG.DEFAULT_SEED for reproducibility
 * 4. Points are truly random within each stratum (not grid-based)
 *
 * This matches the UNFCCC AR-AM-Tool-03 requirement for stratified random sampling
 * and uses the same methodology as the Manual Stratification script.
 */
function generateStratifiedPoints() {
  pointsResultsPanel.clear();

  if (!AppState.allocationInfo || AppState.allocationInfo.length === 0) {
    pointsResultsPanel.clear();
    pointsResultsPanel.add(ui.Label('❌ Please calculate sample size first', STYLES.ERROR));
    return;
  }

  var strataWithPoints = AppState.allocationInfo.filter(function(s) { return s.points > 0; });

  if (strataWithPoints.length === 0) {
    pointsResultsPanel.clear();
    pointsResultsPanel.add(ui.Label('❌ No strata have allocated points', STYLES.ERROR));
    return;
  }

  // Show progress
  pointsResultsPanel.add(ui.Label('⏳ Step 1/3: Converting raster strata to vector polygons...', STYLES.INFO));
  pointsResultsPanel.add(ui.Label('⏳ Step 2/3: Preparing stratified random sampling...', STYLES.INFO));
  strataWithPoints.forEach(function(s) {
    pointsResultsPanel.add(ui.Label(
      '  • ' + s.name + ': ' + s.points + ' random points',
      {fontSize: '11px', margin: '2px 0 2px 16px', color: '#666'}
    ));
  });
  pointsResultsPanel.add(ui.Label('⏳ Step 3/3: Executing random point generation (this may take 60-120 seconds)...', STYLES.INFO));

  print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  print('🎲 Generating Stratified Random Sample Points');
  print('Sampling Method: Stratified Random (Vector-based)');
  print('Number of strata:', strataWithPoints.length);
  print('Random Seed:', CONFIG.DEFAULT_SEED);
  print('');
  print('ALLOCATION:');

  strataWithPoints.forEach(function(s) {
    print('  • ' + s.name + ': ' + s.points + ' points (random within stratum)');
  });

  print('');
  print('Converting raster strata to vector polygons...');

  // Generate points for each stratum independently using vector-based approach
  var allPointsArrays = [];
  var processedCount = 0;

  strataWithPoints.forEach(function(stratumPlan, index) {
    var stratumCode = stratumPlan.code;
    var stratumName = stratumPlan.name;
    var numPoints = stratumPlan.points;

    print('Processing stratum: ' + stratumName + ' (code: ' + stratumCode + ')');

    // Create mask for this stratum
    var stratumMask = AppState.strataImage.select('strata').eq(stratumCode);

    // Convert to vector (this creates polygons from the raster)
    var stratumVectors = stratumMask.selfMask().reduceToVectors({
      geometry: AppState.currentAoi,
      scale: CONFIG.ANALYSIS_SCALE,
      geometryType: 'polygon',
      eightConnected: false,
      labelProperty: 'stratum',
      maxPixels: CONFIG.MAX_PIXELS,
      tileScale: 16
    });

    // Union all polygons for this stratum into single geometry
    var stratumGeometry = stratumVectors.union(CONFIG.MAX_ERROR).geometry();

    // Adaptive buffer retry: try descending buffer distances
    var bufferSequence = CONFIG.BUFFER_RETRY_SEQUENCE;

    function tryBufferAtIndex(bufIdx) {
      if (bufIdx >= bufferSequence.length) {
        print('  Warning: No buffer applied to ' + stratumName + ' (geometry too small for any buffer)');
        generatePointsForGeometry(stratumGeometry);
        return;
      }
      var currentBuffer = bufferSequence[bufIdx];
      var bufferedGeometry = stratumGeometry.buffer(-currentBuffer, CONFIG.MAX_ERROR);
      bufferedGeometry.area({maxError: CONFIG.MAX_ERROR}).evaluate(function(bufArea) {
        if (bufArea && bufArea > 1000) {
          print('  Buffer: -' + currentBuffer + 'm applied to ' + stratumName);
          generatePointsForGeometry(bufferedGeometry);
        } else {
          print('  Buffer -' + currentBuffer + 'm too aggressive for ' + stratumName + ', trying smaller...');
          tryBufferAtIndex(bufIdx + 1);
        }
      });
    }

    function generatePointsForGeometry(finalGeometry) {
      // Generate truly random points using randomPoints (same as Manual script)
      var points = ee.FeatureCollection.randomPoints({
        region: finalGeometry,
        points: numPoints,
        seed: CONFIG.DEFAULT_SEED + index,
        maxError: CONFIG.MAX_ERROR
      });

      // Add metadata
      var pointsWithMeta = points.map(function(p) {
        var coords = p.geometry().coordinates();
        return p.set({
          'stratum_code': stratumCode,
          'stratum_name': stratumName,
          'sampling_type': 'stratified_random',
          'stratification_method': AppState.stratificationMethod,
          'lon': coords.get(0),
          'lat': coords.get(1),
          'date_generated': ee.Date(Date.now()).format('YYYY-MM-dd')
        });
      });

      allPointsArrays.push(pointsWithMeta);
      processedCount++;

      // When all strata processed
      if (processedCount === strataWithPoints.length) {
        var combinedPoints = ee.FeatureCollection(allPointsArrays).flatten();

        // Add sequential IDs
        var pointsList = combinedPoints.toList(combinedPoints.size());
        pointsList.size().evaluate(function(listSize) {
          if (!listSize || listSize <= 0) {
            pointsResultsPanel.clear();
            pointsResultsPanel.add(ui.Label('❌ No points generated', STYLES.ERROR));
            return;
          }

          var sequence = ee.List.sequence(0, listSize - 1);

          var finalPoints = ee.FeatureCollection(
            sequence.map(function(idx) {
              var pt = ee.Feature(pointsList.get(idx));
              return pt.set({
                'point_id': ee.String('BC_').cat(ee.Number(idx).add(1).format('%05d'))
              });
            })
          );

          AppState.currentPoints = finalPoints;

          // Remove old points layer
          var layers = map.layers();
          for (var i = layers.length() - 1; i >= 0; i--) {
            if (layers.get(i).getName().indexOf('Sampling Points') !== -1) {
              map.layers().remove(layers.get(i));
            }
          }

          // Add new points
          map.addLayer(AppState.currentPoints, {color: '00796B'}, 'Sampling Points (' + listSize + ')');

          pointsResultsPanel.clear();
          pointsResultsPanel.add(ui.Label('✓ Step 1/3: Raster converted to vectors', {fontSize: '12px', color: '#00796B', margin: '4px 8px'}));
          pointsResultsPanel.add(ui.Label('✓ Step 2/3: Sampling plan prepared', {fontSize: '12px', color: '#00796B', margin: '4px 8px'}));
          pointsResultsPanel.add(ui.Label('✓ Step 3/3: Random points generated successfully', {fontSize: '12px', color: '#00796B', margin: '4px 8px'}));
          pointsResultsPanel.add(ui.Label(''));
          pointsResultsPanel.add(ui.Label('✓ Points Generated Successfully', STYLES.SUCCESS));
          pointsResultsPanel.add(ui.Label(
            'Total Points: ' + listSize + ' (stratified random)',
            {fontSize: '16px', fontWeight: 'bold', margin: '4px 0'}
          ));

          pointsResultsPanel.add(ui.Label(''));
          pointsResultsPanel.add(ui.Label('Distribution by Stratum:', {fontSize: '12px', fontWeight: 'bold', margin: '4px 0'}));

          // Show breakdown
          strataWithPoints.forEach(function(s) {
            if (s.points > 0) {
              pointsResultsPanel.add(ui.Label(
                '  • ' + s.name + ': ' + s.points + ' random points',
                {fontSize: '11px', margin: '2px 0 2px 8px'}
              ));
            }
          });

          pointsResultsPanel.add(ui.Label(''));
          pointsResultsPanel.add(ui.Label(
            '► Stratified random sampling: Points randomly distributed within each stratum',
            STYLES.INFO
          ));
          pointsResultsPanel.add(ui.Label(
            '► Seed: ' + CONFIG.DEFAULT_SEED + ' (for reproducibility)',
            STYLES.INFO
          ));
          pointsResultsPanel.add(ui.Label(
            '► Vector-based method: Raster strata converted to polygons for true random sampling',
            STYLES.INFO
          ));

          exportPointsButton.setDisabled(false);
          exportStrataButton.setDisabled(false);

          print('');
          print('RESULTS:');
          print('✓ Total points generated:', listSize);
          print('✓ Sampling type: STRATIFIED RANDOM (Vector-based)');
          print('✓ Each point randomly placed within its assigned stratum');
          print('✓ Seed ' + CONFIG.DEFAULT_SEED + ' ensures reproducibility');
          print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        });
      }
    } // end generatePointsForGeometry

    tryBufferAtIndex(0);
  });
}

function createLegend(numClusters) {
  legendPanel.clear();

  var defs = AppState.activeStrataDefinitions || [];
  var palette = Stratifier.generateClusterPalette(defs.length || numClusters || 1);

  defs.forEach(function(def, index) {
    var colorBox = ui.Label('', {
      backgroundColor: palette[index],
      padding: '10px',
      margin: '0 8px 0 0'
    });

    var label = ui.Label(def.name + ' (code ' + def.sourceCode + ')', {fontSize: '12px'});
    legendPanel.add(ui.Panel([colorBox, label], ui.Panel.Layout.flow('horizontal'), {margin: '4px 8px'}));
  });

  if (defs.length === 0) {
    legendPanel.add(ui.Label('Legend unavailable until strata are generated.', {fontSize: '11px', color: '#999', margin: '8px'}));
  }
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
      'Includes: stratum_name, coordinates, sampling_type, stratification_method, date',
      {fontSize: '10px', color: '#666', margin: '4px 0'}
    ));
  } catch (e) {
    downloadLinksPanel.clear();
    downloadLinksPanel.add(ui.Label('❌ Export failed: ' + e, STYLES.ERROR));
  }
}

function exportStrata() {
  if (!AppState.strataImage) {
    alert('No strata to export. Please run stratification first.');
    return;
  }

  downloadLinksPanel.clear();
  downloadLinksPanel.add(ui.Label('⏳ Preparing export...', STYLES.INFO));

  var fmt = exportFormatSelect.getValue();
  var formatType = (fmt === 'SHP') ? 'SHP' : fmt;

  try {
    // Convert strata image to vectors for export
    var strataVectors = AppState.strataImage.reduceToVectors({
      geometry: AppState.currentAoi,
      scale: CONFIG.ANALYSIS_SCALE,
      geometryType: 'polygon',
      eightConnected: false,
      labelProperty: 'stratum_code',
      maxPixels: CONFIG.MAX_PIXELS
    });

    var withMeta = strataVectors.map(function(f) {
      var code = f.get('stratum_code');
      var name = getStratumNameByCode(code);
      return f.set({
        'stratum_name': name,
        'area_ha': f.geometry().area().divide(10000)
      });
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
      'Includes: stratum_name, stratum_code, area_ha, geometry',
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
  map.drawingTools().setShown(true);

  sampleSizeResultsPanel.clear();
  pointsResultsPanel.clear();
  downloadLinksPanel.clear();
  legendPanel.clear();

  confidenceBox.setValue(CONFIG.DEFAULT_CONFIDENCE.toString());
  marginOfErrorBox.setValue(CONFIG.DEFAULT_MARGIN_OF_ERROR.toString());
  plotTypeSelect.setValue('Sediment Core (100 m²)');
  exportFormatSelect.setValue('CSV');
  customPlotSizeBox.style().set('shown', false);

  generateButton.setDisabled(true);
  exportPointsButton.setDisabled(true);
  exportStrataButton.setDisabled(true);

  map.setCenter(-95, 55, 4);

  print('✓ Tool reset - ready for new blue carbon assessment');
}

// =================================================================================
// === 8. INITIALIZATION ===========================================================
// =================================================================================

var drawingTools = map.drawingTools();
drawingTools.setShown(true);
drawingTools.setDrawModes(['polygon', 'rectangle']);
drawingTools.setLinked(false);
drawingTools.setShape('polygon');

map.setControlVisibility({
  layerList: true,
  drawingToolsControl: true,
  fullscreenControl: true,
  zoomControl: true
});

// Console welcome
print('═══════════════════════════════════════════════════════');
print('Blue Carbon Stratified Random Sampling Tool v3.0');
print('═══════════════════════════════════════════════════════');
print('');
print('METHODOLOGY:');
print('  • UNFCCC AR-AM-Tool-03 stratified sampling');
print('  • Proportional allocation by area');
print('  • IPCC Tier 1 generic blue carbon defaults');
print('  • Iterative t-distribution convergence');
print('');
print('AUTOMATIC STRATIFICATION METHODS:');
print('  • Land Cover Based (Copernicus/Dynamic World)');
print('  • Remote Sensing + ML (k-means clustering)');
print('');
print('WORKFLOW:');
print('  1. Define AOI (draw or upload)');
print('  2. Select automatic stratification method');
print('  3. Calculate stratified sample size');
print('  4. Generate stratified random points');
print('  5. Export sampling design');
print('');
print('Ready for blue carbon assessment!');
print('═══════════════════════════════════════════════════════');
