const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * Find Python executable in system PATH
 * Tries multiple names and methods to locate Python
 * @returns {string|null} Path to Python executable or null if not found
 */
const findPythonExecutable = () => {
    const candidates = ["python3", "python", "python.exe"];

    // Try to find using 'where' (Windows) or 'which' (Unix)
    const isWindows = process.platform === "win32";
    const findCommand = isWindows ? "where" : "which";

    for (const pythonCmd of candidates) {
        try {
            const result = execSync(`${findCommand} ${pythonCmd}`, {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "ignore"],
            }).trim();
            if (result) {
                console.log(`[Python] Found executable: ${result}`);
                return result;
            }
        } catch (e) {
            // Command not found, try next candidate
        }
    }

    // Fallback: Try direct spawn to see if it works
    for (const pythonCmd of candidates) {
        try {
            execSync(`${pythonCmd} --version`, {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "ignore"],
            });
            console.log(`[Python] Executable works: ${pythonCmd}`);
            return pythonCmd;
        } catch (e) {
            // Doesn't work, try next
        }
    }

    return null;
};

/**
 * Call Python web scraper service
 * @param {string} url - The website URL to scrape
 * @returns {Promise<Object>} Scraped data in JSON format
 */
const scrapePythonService = async (url) => {
    return new Promise((resolve, reject) => {
        const pythonScriptPath = path.join(__dirname, "pythonWebScraper.py");

        // Verify Python script exists
        if (!fs.existsSync(pythonScriptPath)) {
            return reject(new Error("Python scraper script not found"));
        }

        // Find Python executable
        const pythonExecutable = findPythonExecutable();
        if (!pythonExecutable) {
            return reject(
                new Error(
                    "Python not found in system PATH. Please install Python 3.8+ or ensure it's in your PATH. " +
                        "On macOS/Linux, use 'python3 --version' to verify installation. " +
                        "On Windows, ensure Python is installed and added to PATH.",
                ),
            );
        }

        console.log(`[Scraping] Using Python: ${pythonExecutable}`);

        // Spawn Python process
        const pythonProcess = spawn(pythonExecutable, [pythonScriptPath, url], {
            timeout: 20000, // 20 second timeout
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large responses
            shell: process.platform === "win32", // Use shell on Windows for better PATH resolution
        });

        let output = "";
        let errorOutput = "";

        pythonProcess.stdout.on("data", (data) => {
            output += data.toString();
        });

        pythonProcess.stderr.on("data", (data) => {
            errorOutput += data.toString();
        });

        pythonProcess.on("close", (code) => {
            if (code === 0) {
                try {
                    const result = JSON.parse(output);
                    resolve(result);
                } catch (parseError) {
                    reject(
                        new Error(
                            `Failed to parse Python output: ${parseError.message}`,
                        ),
                    );
                }
            } else {
                reject(
                    new Error(
                        `Python script failed (exit code ${code}): ${errorOutput}`,
                    ),
                );
            }
        });

        pythonProcess.on("error", (err) => {
            const errorMsg =
                err.code === "ENOENT"
                    ? `Python executable not found. Please ensure Python 3.8+ is installed and in your PATH. Error: ${err.message}`
                    : `Failed to spawn Python process: ${err.message}`;
            reject(new Error(errorMsg));
        });

        // Add timeout handling
        setTimeout(() => {
            if (pythonProcess.exitCode === null) {
                pythonProcess.kill();
                reject(
                    new Error(
                        "Python scraping process exceeded 25 second timeout",
                    ),
                );
            }
        }, 25000);
    });
};

module.exports = { scrapePythonService };
