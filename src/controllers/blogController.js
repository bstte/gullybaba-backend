const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Helper function to fetch blog posts from WordPress REST API
const fetchPostsFromWordPress = (queryParams) => {
  return new Promise((resolve, reject) => {
    const url = getApiUrl("blog", queryParams);
    const authHeader = getBasicAuthHeader();

    const options = {
      headers: {
        "Authorization": authHeader
      }
    };

    const req = https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`WordPress API returned status ${res.statusCode}`));
          }
          const posts = JSON.parse(data);

          // WordPress API returns total count headers
          const total = parseInt(res.headers["x-wp-total"], 10) || posts.length;
          const totalPages = parseInt(res.headers["x-wp-totalpages"], 10) || 1;

          resolve({ posts, total, totalPages });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
};

// Get Blog posts listing
exports.getPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const status = req.query.status || "";

    const wpParams = {
      page,
      per_page: limit
    };

    if (search) {
      wpParams.search = search;
    }

    if (status && status !== "all") {
      wpParams.status = status;
    }

    const { posts, total, totalPages } = await fetchPostsFromWordPress(wpParams);

    // Map posts to a simplified frontend structure
    const formattedPosts = posts.map(p => {
      // Extract author from yoast head json if available, otherwise default to Admin
      let authorName = "Admin";
      if (p.yoast_head_json && p.yoast_head_json.twitter_misc) {
        authorName = p.yoast_head_json.twitter_misc["Written by"] || authorName;
      }

      return {
        id: p.id,
        title: p.title ? p.title.rendered : "Untitled",
        slug: p.slug,
        link: p.link,
        status: p.status,
        date: p.date,
        modified: p.modified,
        excerpt: p.excerpt ? p.excerpt.rendered : "",
        author: authorName
      };
    });

    return res.json({
      success: true,
      posts: formattedPosts,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error("Error fetching live WordPress posts:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch blog posts from WordPress API"
    });
  }
};
