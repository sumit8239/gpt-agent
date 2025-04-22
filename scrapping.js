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
    
    // Fetch the webpage with timeout and retry logic
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000, // 10 second timeout
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 500; // Accept all status codes less than 500
      }
    });
    
    // Load the HTML content
    const $ = cheerio.load(response.data);
    
    // Extract head content more efficiently
    const headContent = {
      title: $('title').text(),
      metaTags: [],
      linkTags: [],
      scriptTags: []
    };
    
    // Process meta tags more efficiently
    $('meta').each((_, element) => {
      const attributes = {};
      Object.entries(element.attribs || {}).forEach(([key, value]) => {
        attributes[key] = value;
      });
      headContent.metaTags.push(attributes);
    });
    
    // Process link tags more efficiently
    $('link').each((_, element) => {
      const attributes = {};
      Object.entries(element.attribs || {}).forEach(([key, value]) => {
        attributes[key] = value;
      });
      headContent.linkTags.push(attributes);
    });
    
    // Process script tags more efficiently
    $('head script').each((_, element) => {
      headContent.scriptTags.push({
        type: element.attribs.type || '',
        src: element.attribs.src || '',
        async: 'async' in element.attribs,
        defer: 'defer' in element.attribs
      });
    });
    
    // Extract specific metadata more efficiently
    const metaData = {
      description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'),
      keywords: $('meta[name="keywords"]').attr('content'),
      viewport: $('meta[name="viewport"]').attr('content'),
      robots: $('meta[name="robots"]').attr('content'),
      ogTitle: $('meta[property="og:title"]').attr('content'),
      ogDescription: $('meta[property="og:description"]').attr('content'),
      ogImage: $('meta[property="og:image"]').attr('content'),
      twitterCard: $('meta[name="twitter:card"]').attr('content'),
      twitterTitle: $('meta[name="twitter:title"]').attr('content'),
      twitterDescription: $('meta[name="twitter:description"]').attr('content'),
      twitterImage: $('meta[name="twitter:image"]').attr('content'),
      canonical: $('link[rel="canonical"]').attr('href')
    };
    
    // Return the analysis data
    return {
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
      success: true
    };
    
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