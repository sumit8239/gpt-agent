import * as cheerio from 'cheerio';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Main function to scrape and analyze any website, focusing on head tag content
export async function analyzeWebsite(url) {
  try {
    // Normalize URL format
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log(`Starting analysis of ${url}`);
    
    // Create directory if it doesn't exist
    const scrapedDataDir = path.join(process.cwd(), 'scraped_data');
    console.log(`Creating/checking directory: ${scrapedDataDir}`);
    if (!fs.existsSync(scrapedDataDir)) {
      fs.mkdirSync(scrapedDataDir, { recursive: true });
      console.log(`✅ Created directory: ${scrapedDataDir}`);
    }

    // Generate safe filenames
    const timestamp = Date.now();
    const safeUrl = url.replace(/[^a-zA-Z0-9]/g, '_');
    const htmlFilename = `${safeUrl}_${timestamp}.html`;
    const analysisFilename = `${safeUrl}_${timestamp}_analysis.json`;
    const htmlPath = path.join(scrapedDataDir, htmlFilename);
    const analysisPath = path.join(scrapedDataDir, analysisFilename);

    console.log(`Will save files to:`);
    console.log(`- HTML: ${htmlPath}`);
    console.log(`- Analysis: ${analysisPath}`);

    // Fetch the webpage
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 30000 // 30 second timeout
    });
    
    // Save the full HTML
    console.log(`Saving HTML to ${htmlPath}`);
    await fs.promises.writeFile(htmlPath, response.data, 'utf8');
    console.log(`✅ Saved HTML file`);
    
    // Load the HTML content
    const $ = cheerio.load(response.data);
    
    // Extract head content
    const headContent = {
      title: $('title').text(),
      metaTags: [],
      linkTags: [],
      scriptTags: []
    };
    
    // Get all meta tags
    $('meta').each((_, element) => {
      const attributes = {};
      Object.entries(element.attribs || {}).forEach(([key, value]) => {
        attributes[key] = value;
      });
      headContent.metaTags.push(attributes);
    });
    
    // Get all link tags
    $('link').each((_, element) => {
      const attributes = {};
      Object.entries(element.attribs || {}).forEach(([key, value]) => {
        attributes[key] = value;
      });
      headContent.linkTags.push(attributes);
    });
    
    // Get all script tags in head
    $('head script').each((_, element) => {
      headContent.scriptTags.push({
        type: element.attribs.type || '',
        src: element.attribs.src || '',
        async: 'async' in element.attribs,
        defer: 'defer' in element.attribs
      });
    });
    
    // Extract specific metadata that's commonly used
    const metaData = {
      description: null,
      keywords: null,
      viewport: null,
      robots: null,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      twitterCard: null,
      twitterTitle: null,
      twitterDescription: null,
      twitterImage: null,
      canonical: null
    };
    
    // Process meta tags to extract common metadata
    headContent.metaTags.forEach(meta => {
      if (meta.name === 'description') metaData.description = meta.content;
      if (meta.name === 'keywords') metaData.keywords = meta.content;
      if (meta.name === 'viewport') metaData.viewport = meta.content;
      if (meta.name === 'robots') metaData.robots = meta.content;
      
      // Open Graph tags
      if (meta.property === 'og:title') metaData.ogTitle = meta.content;
      if (meta.property === 'og:description') metaData.ogDescription = meta.content;
      if (meta.property === 'og:image') metaData.ogImage = meta.content;
      
      // Twitter Card tags
      if (meta.name === 'twitter:card') metaData.twitterCard = meta.content;
      if (meta.name === 'twitter:title') metaData.twitterTitle = meta.content;
      if (meta.name === 'twitter:description') metaData.twitterDescription = meta.content;
      if (meta.name === 'twitter:image') metaData.twitterImage = meta.content;
    });
    
    // Extract canonical URL if present
    headContent.linkTags.forEach(link => {
      if (link.rel === 'canonical') metaData.canonical = link.href;
    });
    
    // Extract body content
    const bodyContent = {
      headings: {
        h1: $('h1').length,
        h2: $('h2').length,
        h3: $('h3').length,
        h4: $('h4').length,
        h5: $('h5').length,
        h6: $('h6').length
      },
      images: $('img').length,
      imagesWithAlt: $('img[alt]').length,
      imagesWithoutAlt: $('img:not([alt])').length,
      links: $('a').length,
      internalLinks: $('a[href^="/"], a[href^="' + url + '"]').length,
      externalLinks: $('a[href^="http"]').length - $('a[href^="' + url + '"]').length,
      forms: $('form').length,
      totalScripts: $('script').length,
      totalStylesheets: $('link[rel="stylesheet"]').length,
      wordCount: $('body').text().trim().split(/\s+/).length,
      viewportMeta: !!$('meta[name="viewport"]').length
    };
    
    // Extract content samples for AI analysis
    const contentSamples = {
      mainHeadings: $('h1').map((_, el) => $(el).text().trim()).get(),
      subHeadings: $('h2').map((_, el) => $(el).text().trim()).get(),
      paragraphSamples: $('p').map((_, el) => $(el).text().trim()).get().slice(0, 5)
    };
    
    // Perform SEO analysis
    const seoAnalysis = {
      titleLength: headContent.title.length,
      descriptionLength: metaData.description ? metaData.description.length : 0,
      hasCanonical: !!metaData.canonical,
      hasRobots: !!metaData.robots,
      hasViewport: !!metaData.viewport,
      hasOpenGraph: !!(metaData.ogTitle || metaData.ogDescription || metaData.ogImage),
      hasTwitterCard: !!(metaData.twitterCard || metaData.twitterTitle || metaData.twitterDescription || metaData.twitterImage)
    };
    
    // Gather all the data
    const analysisData = {
      url,
      title: headContent.title,
      metaData,
      headStats: {
        metaTagCount: headContent.metaTags.length,
        linkTagCount: headContent.linkTags.length,
        scriptTagCount: headContent.scriptTags.length
      },
      headTags: {
        meta: headContent.metaTags,
        links: headContent.linkTags,
        scripts: headContent.scriptTags
      },
      bodyContent,
      contentSamples,
      seoAnalysis,
      htmlFile: htmlPath,
      analysisFile: analysisPath,
      fullAnalysisAvailable: true
    };
    
    // Save the analysis data
    console.log(`Saving analysis to ${analysisPath}`);
    await fs.promises.writeFile(analysisPath, JSON.stringify(analysisData, null, 2), 'utf8');
    console.log(`✅ Saved analysis file`);
    
    console.log(`Analysis of ${url} completed successfully`);
    return analysisData;
    
  } catch (error) {
    console.error(`Error analyzing ${url}:`, error);
    return {
      url,
      error: error.message || 'Unknown error occurred',
      title: null,
      metaData: {},
      seoAnalysis: {},
      bodyContent: {},
      contentSamples: {},
      headStats: {},
      headTags: {}
    };
  }
}

// Helper function to check if running on Vercel
function isVercelProduction() {
  return process.env.VERCEL === '1';
}

// Function to run as standalone script
const runScraper = async () => {
  // Check if URL was provided as command line argument
  const targetUrl = process.argv[2];
  
  try {
    const analysis = await analyzeWebsite(targetUrl);
    console.log('Analysis result:', JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error('Failed to run analysis:', error);
  }
};

// If this script is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  runScraper();
}