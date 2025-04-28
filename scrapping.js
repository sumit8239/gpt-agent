import * as cheerio from 'cheerio';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Function to get temporary directory
function getTempDirectory() {
  // Detect Vercel environment - look for multiple possible environment variables
  const isVercel = process.env.VERCEL === '1' || 
                  process.env.VERCEL === 'true' || 
                  process.env.NOW_REGION || 
                  process.env.VERCEL_REGION ||
                  process.cwd().includes('/var/task');
  
  // Use /tmp for Vercel (serverless) environments
  return isVercel ? '/tmp' : path.join(process.cwd(), 'scraped_data');
}

// Generate safe filenames to prevent path length errors
function generateSafeFilename(url, timestamp) {
  // Extract domain from URL
  let domain = '';
  try {
    const urlObj = new URL(url);
    domain = urlObj.hostname.replace(/[^a-zA-Z0-9]/g, '_');
  } catch (error) {
    // If URL parsing fails, use a safe default
    domain = 'webpage';
  }
  
  // Limit the length of the filename to avoid path length issues in Windows
  const maxLength = 50; // Keep the base filename reasonably short
  return `${domain.substring(0, maxLength)}_${timestamp}`;
}

// Main function to scrape and analyze any website, focusing on head tag content
export async function analyzeWebsite(url) {
  try {
    // Normalize URL format
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log(`Starting analysis of ${url}`);
    
    // Create directory if it doesn't exist
    const scrapedDataDir = getTempDirectory();
    console.log(`Creating/checking directory: ${scrapedDataDir}`);
    if (!fs.existsSync(scrapedDataDir)) {
      fs.mkdirSync(scrapedDataDir, { recursive: true });
      console.log(`✅ Created directory: ${scrapedDataDir}`);
    }

    // Generate safe filenames
    const timestamp = Date.now();
    const safeBasename = generateSafeFilename(url, timestamp);
    const htmlFilename = `${safeBasename}.html`;
    const analysisFilename = `${safeBasename}_analysis.json`;
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

// Add a function to extract more general website insights, not just SEO-focused
export async function extractWebsiteInsights(url) {
  try {
    console.log(`Starting general website analysis for ${url}`);
    
    const analysisData = await analyzeWebsite(url);
    
    if (analysisData.error) {
      throw new Error(`Failed to analyze website: ${analysisData.error}`);
    }

    // Create a more general analysis focusing on various aspects
    const websiteInsights = {
      general: {
        title: analysisData.title,
        description: analysisData.metaData?.description,
        contentStructure: {
          headings: analysisData.bodyContent?.headings,
          paragraphs: analysisData.bodyContent?.wordCount > 0 ? "Present" : "Limited",
          mediaElements: analysisData.bodyContent?.images
        }
      },
      userExperience: {
        hasViewportMeta: analysisData.seoAnalysis?.hasViewport,
        imagesWithAlt: analysisData.bodyContent?.imagesWithAlt,
        imagesWithoutAlt: analysisData.bodyContent?.imagesWithoutAlt,
        navigationElements: analysisData.bodyContent?.internalLinks
      },
      contentQuality: {
        wordCount: analysisData.bodyContent?.wordCount,
        headingStructure: analysisData.bodyContent?.headings?.h1 > 0 ? "Has main headings" : "Missing main headings",
        contentSamples: analysisData.contentSamples
      },
      technicalAspects: {
        scriptCount: analysisData.headStats?.scriptTagCount,
        stylesheetCount: analysisData.headStats?.linkTagCount,
        metaTagCount: analysisData.headStats?.metaTagCount,
        hasSocialTags: analysisData.seoAnalysis?.hasOpenGraph || analysisData.seoAnalysis?.hasTwitterCard
      }
    };

    return {
      success: true,
      insights: websiteInsights,
      rawData: analysisData
    };
  } catch (error) {
    console.error('Error in extractWebsiteInsights:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to analyze website for task generation, now more general purpose
export async function analyzeWebsiteForTasks(url, domainFocus = "general") {
  try {
    console.log(`Starting ${domainFocus} analysis for ${url}`);
    
    const analysisData = await analyzeWebsite(url);
    
    if (analysisData.error) {
      throw new Error(`Failed to analyze website: ${analysisData.error}`);
    }

    // Create a prompt that's appropriate for the domain focus
    let analysisPrompt = `Based on the website analysis, identify specific actionable tasks:

URL: ${url}
Title: ${analysisData.title || 'Not found'}
Description: ${analysisData.metaData?.description || 'Not found'}
`;

    // Add domain-specific analysis sections
    if (domainFocus === "seo") {
      analysisPrompt += `
SEO Analysis:
- Title Length: ${analysisData.seoAnalysis?.titleLength || 0} characters
- Description Length: ${analysisData.seoAnalysis?.descriptionLength || 0} characters
- Has Canonical URL: ${analysisData.seoAnalysis?.hasCanonical ? 'Yes' : 'No'}
- Has Robots Meta: ${analysisData.seoAnalysis?.hasRobots ? 'Yes' : 'No'}
- Has Open Graph Tags: ${analysisData.seoAnalysis?.hasOpenGraph ? 'Yes' : 'No'}
- Has Twitter Card Tags: ${analysisData.seoAnalysis?.hasTwitterCard ? 'Yes' : 'No'}
`;
    } else if (domainFocus === "content") {
      analysisPrompt += `
Content Analysis:
- Headings Structure: H1 (${analysisData.bodyContent?.headings?.h1 || 0}), H2 (${analysisData.bodyContent?.headings?.h2 || 0})
- Word Count: ${analysisData.bodyContent?.wordCount || 0}
- Content Samples: ${JSON.stringify(analysisData.contentSamples?.paragraphSamples || [])}
`;
    } else if (domainFocus === "ux") {
      analysisPrompt += `
User Experience Analysis:
- Has Viewport Meta: ${analysisData.seoAnalysis?.hasViewport ? 'Yes' : 'No'}
- Images: ${analysisData.bodyContent?.images || 0} (${analysisData.bodyContent?.imagesWithAlt || 0} with alt text)
- Internal Links: ${analysisData.bodyContent?.internalLinks || 0}
- External Links: ${analysisData.bodyContent?.externalLinks || 0}
`;
    } else {
      // General website analysis
      analysisPrompt += `
Website Overview:
- Headings: H1 (${analysisData.bodyContent?.headings?.h1 || 0}), H2 (${analysisData.bodyContent?.headings?.h2 || 0})
- Images: ${analysisData.bodyContent?.images || 0} (${analysisData.bodyContent?.imagesWithAlt || 0} with alt text)
- Links: Internal (${analysisData.bodyContent?.internalLinks || 0}), External (${analysisData.bodyContent?.externalLinks || 0})
- Word Count: ${analysisData.bodyContent?.wordCount || 0}
- Script Tags: ${analysisData.headStats?.scriptTagCount || 0}
- Style Sheets: ${analysisData.headStats?.linkTagCount || 0}
`;
    }

    analysisPrompt += `
Please provide specific, actionable tasks in the following format:

{
  "tasks": [
    {
      "title": "Task Title",
      "description": "Detailed steps to complete this task",
      "timeEstimate": "X hours"
    }
  ]
}`;

    return {
      success: true,
      analysisPrompt,
      rawData: analysisData
    };
  } catch (error) {
    console.error('Error in analyzeWebsiteForTasks:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Export additional functions for other modules to use
export default {
  analyzeWebsite,
  extractWebsiteInsights,
  analyzeWebsiteForTasks
};