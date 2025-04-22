import * as cheerio from 'cheerio';
import axios from 'axios';

// Main function to scrape and analyze any website, focusing on head tag content
export async function analyzeWebsite(url) {
  try {
    // Normalize URL format
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log(`Starting head tag analysis of ${url}`);
    
    // Fetch the webpage
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 30000 // 30 second timeout
    });
    
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
      }
    };
    
    console.log(`Head analysis of ${url} completed successfully`);
    return analysisData;
    
  } catch (error) {
    console.error(`Error analyzing ${url}:`, error);
    return {
      url,
      error: error.message,
      success: false
    };
  }
}

// Function to run as standalone script
const runScraper = async () => {
  // Check if URL was provided as command line argument
  const targetUrl = process.argv[2] || 'https://dyzo.ai';
  
  try {
    const analysis = await analyzeWebsite(targetUrl);
    console.log('Head analysis result:', JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error('Failed to run head analysis:', error);
  }
};

// If this script is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  runScraper();
}