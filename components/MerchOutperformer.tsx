'use client';

import Image from 'next/image';
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, Image as ImageIcon, Sparkles, Search, ShoppingBag, Copy, Check, Download, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import toast from 'react-hot-toast';

const STYLE_PRESETS = [
  { id: 'none', name: 'Original Style', icon: '🎨', description: 'Follow the original design style.' },
  { id: 'vintage_distressed', name: 'Vintage Distressed', icon: '📻', description: 'Worn-out, cracked texture, retro color palette.' },
  { id: 'retro', name: 'Retro Style', icon: '📼', description: 'Classic retro aesthetics, bold colors, nostalgic feel.' },
  { id: 'coquette', name: 'Coquette Bow', icon: '🎀', description: 'Soft, feminine, pastel colors, ribbons and bows, delicate.' },
  { id: 'vintage_western', name: 'Vintage Western', icon: '🤠', description: 'Rustic, cowboy motifs, desert tones, classic western typography.' },
  { id: 'doodle', name: 'Doodle Hand Drawn', icon: '✏️', description: 'Sketchy, hand-drawn lines, playful, imperfect doodle style.' },
];

const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY! });

// Types for the analysis results
interface AnalysisResult {
  text: string;
  niche: string;
  description: string;
  prompts: string[];
}

interface SEOResult {
  title: string;
  tags: string[];
  description: string;
}

interface DesignVariation {
  id: string;
  generatedImageUrl: string | null;
  transparentImageUrl: string | null;
  status: 'idle' | 'generating' | 'removing_bg' | 'completed' | 'error';
  error?: string;
}

interface DesignItem {
  id: string;
  file: File;
  preview: string;
  analysis: AnalysisResult | null;
  seo: SEOResult | null;
  variations: DesignVariation[];
  status: 'idle' | 'analyzing' | 'generating' | 'removing_bg' | 'completed' | 'error';
  error?: string;
}

export default function MerchOutperformer() {
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [instructions, setInstructions] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('none');
  const [isProcessingAll, setIsProcessingAll] = useState(false);

  // Cleanup object URLs on unmount
  const designsRef = React.useRef(designs);
  React.useEffect(() => {
    designsRef.current = designs;
  }, [designs]);

  React.useEffect(() => {
    return () => {
      designsRef.current.forEach(d => {
        if (d.preview.startsWith('blob:')) {
          URL.revokeObjectURL(d.preview);
        }
      });
    };
  }, []);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newDesigns = acceptedFiles.map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      preview: URL.createObjectURL(file),
      analysis: null,
      seo: null,
      variations: [
        { id: 'v1', generatedImageUrl: null, transparentImageUrl: null, status: 'idle' as const },
        { id: 'v2', generatedImageUrl: null, transparentImageUrl: null, status: 'idle' as const },
        { id: 'v3', generatedImageUrl: null, transparentImageUrl: null, status: 'idle' as const }
      ],
      status: 'idle' as const
    }));
    setDesigns(prev => [...prev, ...newDesigns]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    multiple: true
  });

  const removeDesign = (id: string) => {
    setDesigns(prev => {
      const design = prev.find(d => d.id === id);
      if (design) URL.revokeObjectURL(design.preview);
      return prev.filter(d => d.id !== id);
    });
  };

  const resizeImage = (file: File, maxWidth = 768): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxWidth) {
              height *= maxWidth / width;
              width = maxWidth;
            }
          } else {
            if (height > maxWidth) {
              width *= maxWidth / height;
              height = maxWidth;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Could not get canvas context'));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          const base64String = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
          resolve(base64String);
        };
        img.onerror = reject;
      };
      reader.onerror = reject;
    });
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied!`);
    } catch (err) {
      console.error('Failed to copy: ', err);
      toast.error('Failed to copy to clipboard');
    }
  };

  const withRetry = async <T,>(fn: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> => {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        // Check if it's a 503 or 429 error
        const isRetryable = error?.message?.includes('503') || 
                           error?.message?.includes('429') || 
                           error?.message?.includes('high demand') ||
                           error?.status === 'UNAVAILABLE';
        
        if (isRetryable && i < maxRetries - 1) {
          const delay = initialDelay * Math.pow(2, i);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  };

  const runAnalysis = async (designId: string) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;

    setDesigns(prev => prev.map(d => d.id === designId ? { ...d, status: 'analyzing', error: undefined } : d));

    try {
      const base64Image = await resizeImage(design.file);

      const styleInfo = STYLE_PRESETS.find(s => s.id === selectedStyle);
      const stylePrompt = styleInfo && styleInfo.id !== 'none' 
        ? `Apply a ${styleInfo.name} style: ${styleInfo.description}` 
        : "Follow the original design's style but improve the execution.";

              const combinedResponse = await withRetry(() => ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: {
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64Image } },
            {
              text: `You are an expert Etsy digital product analyst and SEO specialist. Analyze this uploaded t-shirt design and generate 3 high-converting Etsy Digital PNG listing variations.
              
              **PART 1: Design Analysis**
              1. Extract the exact text/quote written on it. 
              2. Identify the core niche. 
              3. Describe the visual layout, typography DNA, and illustration style. 
              4. Based on the user's upgrade instructions: "${instructions}" and the selected style: "${stylePrompt}", write 3 highly detailed image generation prompts (as an array) that improve upon this design for high-quality PNG assets.
              
              **Variation Strategy:**
              - **Variation 1 (Reverse Engineering & Polish):** Perform a high-fidelity reconstruction. Respect the original's spatial hierarchy, typography style, and core composition. Upgrade it to look like it was made by a professional graphic designer—sharper edges, better kerning, and premium textures, but keeping the "soul" of the original.
              - **Variation 2 (Vintage Distressed Style):** Re-imagine the design with a worn-out, cracked texture and a muted retro color palette. Focus on a "weathered" look that feels like a well-loved vintage tee from the 70s.
              - **Variation 3 (Retro Vintage Style):** Re-imagine the design with classic retro aesthetics, bold nostalgic colors, and clean but aged typography. Focus on the vibrant, groovy vibes of the 80s and 90s without the heavy distressing.
              
              **Crucial Constraints: Each prompt MUST explicitly state that the final image must be isolated on a solid black background, with NO fabric, NO mockups, and NO humans. It must be a flat, standalone graphic.** 
              Ensure the extracted text is included in quotes for the image generator.
              
              **PART 2: Etsy SEO Listing (Use Google Search)**
              **MANDATORY: Use Google Search to find current trending Etsy keywords and competitor listing patterns for the identified niche. Incorporate these high-volume keywords naturally into the listing.**
              Rules: Do not use trademarked words. Focus on keywords like 'Digital Download', 'PNG for T-shirt', 'Sublimation Design', etc.
              Provide: 
              - Title (max 140 chars, keyword-rich)
              - 13 Tags (comma separated, max 20 chars each)
              - Product Description: MUST follow this exact structure:
                [A comma-separated list of 8-10 high-volume keywords related to the niche]

                ✨ This design is on a transparent background – easy to use for shirts, printables, stickers, journals, and more.

                🔹 IMPORTANT – Not an SVG File
                • This is a PNG file for download. No physical product will be shipped.
                • Colors may vary slightly due to screen and printer differences.

                🛠️ Before You Buy
                Please make sure PNG files work for your project.

                Resolution: 4500x5400 px (High-Quality Print Ready)

                📦 What You’ll Receive
                1 high-resolution PNG files (transparent background):

                🔒 Usage Terms
                ✅ Personal Use – Unlimited
                ✅ Commercial Use – Unlimited on physical products
                ✅ POD (Print-On-Demand) – Allowed
                ✅ You can modify this file for use on physical items

                🚫 NOT allowed:
                ❌ Reselling, sharing, or distributing this digital file
                ❌ Editing the file to sell as another digital product
                ❌ Uploading the design to apps or websites without a watermark

                If you have any questions or concerns, please feel free to contact me. Your satisfaction is my top priority.

                ❗ No Refunds
                Due to the nature of digital downloads, all sales are final.

                Thank you for supporting my shop! Happy crafting! 💖
              
              If you detect any trademarked brands (like Disney, Nike, Marvel, etc.), start your response with "TRADEMARK_VIOLATION: [Brand Name]".
              
              Return the result in a RAW JSON format (no markdown blocks) with keys: "text", "niche", "description", "prompts" (array of 3 strings), "title", "tags", "listingDescription".`
            }
          ]
        },
        config: {
          tools: [{ googleSearch: {} }]
        }
      }));

      const responseText = combinedResponse.text;
      if (!responseText) throw new Error('Failed to process design');

      if (responseText.includes('TRADEMARK_VIOLATION')) {
        const brandMatch = responseText.match(/TRADEMARK_VIOLATION: \[(.*?)\]/);
        const brandName = brandMatch ? brandMatch[1] : 'Unknown Brand';
        setDesigns(prev => prev.map(d => d.id === designId ? { ...d, status: 'error', error: `Trademark violation detected: ${brandName}` } : d));
        toast.error(`Trademark violation in ${design.file.name}: ${brandName}`);
        return;
      }

      // Clean up the response text to ensure it's valid JSON
      // Find the first '{' and last '}' to extract the JSON object
      const start = responseText.indexOf('{');
      const end = responseText.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('Invalid response format from AI');
      
      const jsonStr = responseText.substring(start, end + 1);
      const data = JSON.parse(jsonStr);

      setDesigns(prev => prev.map(d => d.id === designId ? { 
        ...d, 
        status: 'completed',
        analysis: {
          text: data.text,
          niche: data.niche,
          description: data.description,
          prompts: Array.isArray(data.prompts) ? data.prompts : [data.prompt || data.prompts]
        },
        seo: {
          title: data.title,
          tags: Array.isArray(data.tags) ? data.tags : (data.tags?.split(',') || []),
          description: data.listingDescription
        }
      } : d));

    } catch (error: any) {
      console.error(error);
      setDesigns(prev => prev.map(d => d.id === designId ? { ...d, status: 'error', error: 'Analysis failed' } : d));
    }
  };

  const generateImage = async (designId: string, variationIndex: number) => {
    const design = designs.find(d => d.id === designId);
    if (!design || !design.analysis || !design.analysis.prompts[variationIndex]) return;

    const aistudio = (window as any).aistudio;
    if (typeof window !== 'undefined' && aistudio) {
      const hasKey = await aistudio.hasSelectedApiKey();
      if (!hasKey) {
        toast.error('Please select a paid Gemini API key.');
        await aistudio.openSelectKey();
        return;
      }
    }

    setDesigns(prev => prev.map(d => d.id === designId ? { 
      ...d, 
      variations: d.variations.map((v, i) => i === variationIndex ? { 
        ...v, 
        status: 'generating',
        transparentImageUrl: null 
      } : v)
    } : d));

    try {
      const imageResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: { parts: [{ text: design.analysis!.prompts[variationIndex] }] },
        config: {
          imageConfig: { aspectRatio: "3:4", imageSize: "1K" }
        }
      }));

      let imageUrl = '';
      for (const part of imageResponse.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          imageUrl = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }
      
      if (imageUrl) {
        setDesigns(prev => prev.map(d => d.id === designId ? { 
          ...d, 
          variations: d.variations.map((v, i) => i === variationIndex ? { 
            ...v, 
            generatedImageUrl: imageUrl, 
            status: 'completed' 
          } : v)
        } : d));
        
        toast.success(`Variation ${variationIndex + 1} generated!`);
      } else {
        throw new Error('Failed to generate image');
      }
    } catch (error: any) {
      console.error(error);
      setDesigns(prev => prev.map(d => d.id === designId ? { 
        ...d, 
        variations: d.variations.map((v, i) => i === variationIndex ? { ...v, status: 'error', error: 'Image generation failed' } : v)
      } : d));
    }
  };

  const generateAllVariations = async (designId: string) => {
    const design = designs.find(d => d.id === designId);
    if (!design || !design.analysis) return;

    setDesigns(prev => prev.map(d => d.id === designId ? { ...d, status: 'generating' } : d));
    
    const promises = design.analysis.prompts.map((_, i) => generateImage(designId, i));
    await Promise.all(promises);
    
    setDesigns(prev => prev.map(d => d.id === designId ? { ...d, status: 'completed' } : d));
  };

  const processAll = async () => {
    setIsProcessingAll(true);
    const pendingDesigns = designs.filter(d => d.status === 'idle' || d.status === 'error');
    
    // Stagger the start of each analysis to avoid overwhelming the API and hitting 503 errors
    const analysisPromises = pendingDesigns.map(async (design, index) => {
      // Stagger the start of each analysis by 800ms
      await new Promise(resolve => setTimeout(resolve, index * 800));
      return runAnalysis(design.id);
    });

    await Promise.all(analysisPromises);
    setIsProcessingAll(false);
  };

  const downloadImage = (imageUrl: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadAll = () => {
    const completedDesigns = designs.filter(d => d.variations.some(v => v.generatedImageUrl || v.transparentImageUrl));
    if (completedDesigns.length === 0) {
      toast.error('No completed designs to download');
      return;
    }

    let downloadCount = 0;
    completedDesigns.forEach((d) => {
      d.variations.forEach((v, vIndex) => {
        if (v.generatedImageUrl || v.transparentImageUrl) {
          setTimeout(() => {
            downloadImage(
              v.transparentImageUrl || v.generatedImageUrl!, 
              `etsy-design-${d.id}-v${vIndex + 1}-${v.transparentImageUrl ? 'transparent' : 'original'}.png`
            );
          }, downloadCount++ * 400);
        }
      });
    });
    toast.success(`Downloading ${downloadCount} files...`);
  };

  const removeBackground = async (designId: string, variationIndex: number) => {
    const design = designs.find(d => d.id === designId);
    const variation = design?.variations[variationIndex];
    const imageUrl = variation?.generatedImageUrl;
    
    if (!imageUrl) return;

    setDesigns(prev => prev.map(d => d.id === designId ? { 
      ...d, 
      variations: d.variations.map((v, i) => i === variationIndex ? { ...v, status: 'removing_bg' } : v)
    } : d));

    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = imageUrl;
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      const threshold = 45; 
      
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        const intensity = (r + g + b) / 3;
        if (intensity < threshold) {
          if (intensity > threshold - 15) {
            data[i + 3] = Math.floor(((intensity - (threshold - 15)) / 15) * 255);
          } else {
            data[i + 3] = 0;
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);
      const transparentUrl = canvas.toDataURL('image/png');

      setDesigns(prev => prev.map(d => d.id === designId ? { 
        ...d, 
        variations: d.variations.map((v, i) => i === variationIndex ? { 
          ...v, 
          transparentImageUrl: transparentUrl, 
          status: 'completed' 
        } : v)
      } : d));
      
      toast.success(`Background removed for variation ${variationIndex + 1}!`);
    } catch (error) {
      console.error(error);
      setDesigns(prev => prev.map(d => d.id === designId ? { 
        ...d, 
        variations: d.variations.map((v, i) => i === variationIndex ? { ...v, status: 'error', error: 'Background removal failed' } : v)
      } : d));
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 md:py-12">
      <header className="mb-12 text-center">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-medium mb-4"
        >
          <Sparkles size={14} />
          <span>Powered by Gemini 2.5 Flash & Imagen 3</span>
        </motion.div>
        <h1 className="text-3xl md:text-6xl font-bold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-500">
          Etsy Digital PNG Pro
        </h1>
        <p className="text-zinc-400 text-base md:text-lg max-w-2xl mx-auto px-4">
          Reverse-engineer best-selling designs and upgrade them for Etsy Digital Products (PNG for POD).
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar / Input Section */}
        <div className="lg:col-span-4 space-y-6 order-2 lg:order-1">
          <div className="glass-card p-5 md:p-6 lg:sticky lg:top-8">
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
              <Upload size={20} className="text-purple-500" />
              Batch Upload
            </h2>

            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 ${
                isDragActive ? 'border-purple-500 bg-purple-500/5' : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/30'
              }`}
            >
              <input {...getInputProps()} />
              <div className="space-y-4">
                <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto">
                  <Upload size={24} className="text-zinc-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-200">Drop multiple designs</p>
                  <p className="text-xs text-zinc-500 mt-1">PNG, JPG up to 10MB each</p>
                </div>
              </div>
            </div>

            {designs.length > 0 && (
              <div className="mt-6 space-y-3">
                <div className="flex items-center justify-between text-xs font-bold text-zinc-500 uppercase tracking-widest">
                  <span>Queue ({designs.length})</span>
                  <button 
                    onClick={() => {
                      designs.forEach(d => URL.revokeObjectURL(d.preview));
                      setDesigns([]);
                    }} 
                    className="text-red-400 hover:text-red-300"
                  >
                    Clear All
                  </button>
                </div>
                <div className="max-h-60 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {designs.map((d) => (
                    <div key={d.id} className="flex items-center gap-3 p-2 bg-zinc-950 rounded-lg border border-zinc-800 group">
                      <Image src={d.preview} width={40} height={40} className="w-10 h-10 rounded object-cover" alt="" referrerPolicy="no-referrer" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{d.file.name}</p>
                        <p className={`text-[10px] uppercase font-bold ${
                          d.status === 'completed' ? 'text-emerald-500' : 
                          d.status === 'error' ? 'text-red-500' : 
                          'text-zinc-500'
                        }`}>{d.status}</p>
                      </div>
                      <button onClick={() => removeDesign(d.id)} className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-800 rounded transition-all">
                        <AlertCircle size={14} className="text-zinc-500" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 space-y-4">
              <div>
                <span className="text-sm font-medium text-zinc-400 mb-3 block">Style Preset</span>
                <div className="grid grid-cols-3 gap-2">
                  {STYLE_PRESETS.map((style) => (
                    <button
                      key={style.id}
                      onClick={() => setSelectedStyle(style.id)}
                      title={style.name}
                      className={`aspect-square rounded-lg flex flex-col items-center justify-center gap-1 transition-all border ${
                        selectedStyle === style.id 
                          ? 'bg-purple-500/20 border-purple-500 text-purple-400' 
                          : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'
                      }`}
                    >
                      <span className="text-xl">{style.icon}</span>
                    </button>
                  ))}
                </div>
                {selectedStyle !== 'none' && (
                  <p className="text-[10px] text-zinc-500 mt-2 italic">
                    {STYLE_PRESETS.find(s => s.id === selectedStyle)?.description}
                  </p>
                )}
              </div>

              <label className="block">
                <span className="text-sm font-medium text-zinc-400 mb-2 block">Global Upgrade Instructions</span>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g., Make it cyberpunk style, change colors to neon..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none min-h-[100px] transition-all"
                  suppressHydrationWarning
                />
              </label>

              <button
                onClick={processAll}
                disabled={isProcessingAll || designs.length === 0}
                className="w-full gradient-button disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isProcessingAll ? (
                  <>
                    <Loader2 size={20} className="animate-spin" />
                    <span>Processing Batch...</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={20} />
                    <span>Process All Designs</span>
                  </>
                )}
              </button>

              {designs.some(d => d.variations.some(v => v.generatedImageUrl)) && (
                <button
                  onClick={downloadAll}
                  className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 border border-zinc-700"
                >
                  <Download size={18} />
                  <span>Download All Variations</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Main Stage */}
        <div className="lg:col-span-8 space-y-6 md:space-y-8 order-1 lg:order-2">
          <AnimatePresence mode="popLayout">
            {designs.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center justify-center min-h-[400px] glass-card p-12 text-center border-dashed"
              >
                <div className="w-16 h-16 rounded-2xl bg-zinc-800/50 flex items-center justify-center mb-6">
                  <ImageIcon size={32} className="text-zinc-600" />
                </div>
                <h3 className="text-xl font-semibold mb-2 text-zinc-300">No Designs Uploaded</h3>
                <p className="text-zinc-500 max-w-md">
                  Drop multiple t-shirt designs to start your batch upgrade process.
                </p>
              </motion.div>
            ) : (
              <div className="space-y-12">
                {designs.map((design, index) => (
                  <motion.div
                    key={design.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="space-y-6"
                  >
                    <div className="flex items-center gap-4 mb-2">
                      <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 font-bold text-sm">
                        {index + 1}
                      </div>
                      <h3 className="text-lg font-bold truncate">{design.file.name}</h3>
                      {design.status === 'analyzing' && <Loader2 size={16} className="animate-spin text-purple-500" />}
                    </div>

                    {design.analysis && (
                      <div className="space-y-6">
                        {/* Prompt Card */}
                        <div className="glass-card p-5 md:p-8 border-purple-500/20 bg-purple-500/5">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                            <h3 className="text-lg md:text-xl font-bold flex items-center gap-2">
                              <Sparkles size={20} className="text-purple-400" />
                              Upgraded Design Prompts
                            </h3>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                onClick={() => generateAllVariations(design.id)}
                                disabled={design.status === 'generating'}
                                className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-sm font-medium transition-colors disabled:opacity-50"
                              >
                                {design.status === 'generating' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                <span>{design.status === 'generating' ? 'Generating All...' : 'Generate 3 Variations'}</span>
                              </button>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {design.analysis.prompts.map((p, i) => (
                              <div key={i} className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-bold text-zinc-500 uppercase">Prompt {i + 1}</span>
                                  <button onClick={() => handleCopy(p, `Prompt ${i + 1}`)} className="p-1 hover:bg-zinc-800 rounded">
                                    <Copy size={12} className="text-zinc-500" />
                                  </button>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg text-[10px] font-mono text-zinc-400 leading-relaxed border border-zinc-800 h-24 overflow-y-auto custom-scrollbar">
                                  {p}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Comparison Section */}
                        <div className="space-y-6">
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            {/* Original */}
                            <div className="glass-card overflow-hidden flex flex-col border-zinc-800">
                              <div className="p-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Original</span>
                                <ImageIcon size={14} className="text-zinc-600" />
                              </div>
                              <div className="aspect-[3/4] bg-zinc-950 flex items-center justify-center p-2">
                                <Image 
                                  src={design.preview} 
                                  alt="Original" 
                                  width={400}
                                  height={533}
                                  className="max-w-full max-h-full object-contain" 
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                            </div>

                            {/* Variations */}
                            {design.variations.map((variation, vIndex) => (
                              <div key={variation.id} className="glass-card overflow-hidden border-purple-500/30 flex flex-col">
                                <div className="p-3 border-b border-zinc-800 flex items-center justify-between bg-purple-500/10">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400">Variation {vIndex + 1}</span>
                                  <Sparkles size={14} className="text-purple-400" />
                                </div>
                                <div className="flex-1 aspect-[3/4] bg-zinc-950 flex items-center justify-center p-2 relative">
                                  {variation.status === 'generating' || variation.status === 'removing_bg' ? (
                                    <div className="flex flex-col items-center gap-3 text-zinc-400">
                                      <div className="relative w-8 h-8">
                                        <div className="absolute inset-0 rounded-full border-2 border-purple-500/20" />
                                        <div className="absolute inset-0 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
                                      </div>
                                      <span className="text-[10px] animate-pulse text-center px-2">
                                        {variation.status === 'generating' ? 'Rendering...' : 'Removing BG...'}
                                      </span>
                                    </div>
                                  ) : variation.generatedImageUrl ? (
                                    <div className="relative w-full h-full group">
                                      <div className={`w-full h-full flex items-center justify-center rounded-lg overflow-hidden ${variation.transparentImageUrl ? 'bg-[url("https://www.transparenttextures.com/patterns/checkerboard.png")] bg-repeat' : 'bg-black'}`}>
                                        <Image 
                                          src={variation.transparentImageUrl || variation.generatedImageUrl} 
                                          alt={`Variation ${vIndex + 1}`} 
                                          width={400}
                                          height={533}
                                          className="max-w-full max-h-full object-contain" 
                                          referrerPolicy="no-referrer"
                                        />
                                      </div>
                                      {variation.status === 'error' && (
                                        <div className="absolute inset-0 bg-red-500/20 flex flex-col items-center justify-center gap-2 backdrop-blur-sm rounded-lg">
                                          <AlertCircle size={24} className="text-red-500" />
                                          <span className="text-[10px] font-bold text-red-500 px-4 text-center">Generation Failed</span>
                                        </div>
                                      )}
                                    </div>
                                  ) : variation.status === 'error' ? (
                                    <div className="flex flex-col items-center gap-3 text-red-500 text-center p-4">
                                      <AlertCircle size={24} />
                                      <span className="text-[10px] font-bold">Generation Failed</span>
                                      <button 
                                        onClick={() => generateImage(design.id, vIndex)}
                                        className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[10px] font-bold transition-all border border-red-500/20"
                                      >
                                        Retry
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex flex-col items-center gap-3 text-zinc-600 text-center">
                                      <Sparkles size={24} className="opacity-20" />
                                      <button 
                                        onClick={() => generateImage(design.id, vIndex)}
                                        className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-bold transition-all border border-zinc-700"
                                      >
                                        Generate
                                      </button>
                                    </div>
                                  )}
                                </div>
                                
                                {variation.generatedImageUrl && (
                                  <div className="p-2 border-t border-zinc-800 bg-zinc-900/30 flex flex-col gap-2">
                                    <div className="grid grid-cols-2 gap-2">
                                      <button
                                        onClick={() => generateImage(design.id, vIndex)}
                                        disabled={variation.status === 'generating' || variation.status === 'removing_bg'}
                                        className="flex items-center justify-center gap-2 px-2 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-bold transition-all border border-zinc-700 disabled:opacity-50"
                                      >
                                        <RefreshCw size={10} className={variation.status === 'generating' ? 'animate-spin' : ''} />
                                        <span>Regen</span>
                                      </button>
                                      <button
                                        onClick={() => removeBackground(design.id, vIndex)}
                                        disabled={variation.status === 'removing_bg' || !!variation.transparentImageUrl}
                                        className="flex items-center justify-center gap-2 px-2 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[10px] font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                      >
                                        {variation.status === 'removing_bg' ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                        <span>{variation.transparentImageUrl ? 'BG Removed' : 'Remove BG'}</span>
                                      </button>
                                    </div>
                                    <button
                                      onClick={() => downloadImage(
                                        variation.transparentImageUrl || variation.generatedImageUrl!, 
                                        `etsy-design-${design.id}-v${vIndex + 1}-${variation.transparentImageUrl ? 'transparent' : 'original'}.png`
                                      )}
                                      className="w-full flex items-center justify-center gap-2 px-2 py-1.5 rounded-lg bg-white hover:bg-zinc-100 text-black text-[10px] font-bold transition-all"
                                    >
                                      <Download size={10} />
                                      <span>Download</span>
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* SEO Section */}
                        {design.seo && (
                          <div className="glass-card p-5 md:p-8">
                            <h3 className="text-lg md:text-xl font-bold mb-6 flex items-center gap-2">
                              <ShoppingBag size={20} className="text-indigo-400" />
                              Etsy Digital SEO Listing
                            </h3>
                            <div className="space-y-6">
                              <div className="space-y-2">
                                <label className="text-[10px] md:text-xs font-bold text-zinc-500 uppercase tracking-widest">Product Title</label>
                                <div className="flex items-center gap-2 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                                  <span className="flex-1 text-xs md:text-sm truncate">{design.seo.title}</span>
                                  <button onClick={() => handleCopy(design.seo!.title, 'Title')} className="p-1.5 hover:bg-zinc-800 rounded transition-colors shrink-0">
                                    <Copy size={14} className="text-zinc-500" />
                                  </button>
                                </div>
                              </div>

                              <div className="space-y-2">
                                <label className="text-[10px] md:text-xs font-bold text-zinc-500 uppercase tracking-widest">Etsy Tags (13)</label>
                                <div className="flex flex-wrap gap-2 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                                  {design.seo.tags.map((tag, i) => (
                                    <span key={i} className="px-2 py-1 bg-zinc-800 rounded text-[10px] md:text-xs text-zinc-300 border border-zinc-700">
                                      {tag.trim()}
                                    </span>
                                  ))}
                                  <button 
                                    onClick={() => handleCopy(design.seo!.tags.join(', '), 'Tags')} 
                                    className="ml-auto p-1.5 hover:bg-zinc-800 rounded transition-colors"
                                  >
                                    <Copy size={14} className="text-zinc-500" />
                                  </button>
                                </div>
                              </div>

                              <div className="space-y-2">
                                <label className="text-[10px] md:text-xs font-bold text-zinc-500 uppercase tracking-widest">Etsy Listing Description</label>
                                <div className="flex items-start gap-2 p-3 md:p-4 bg-zinc-950 rounded-lg border border-zinc-800">
                                  <span className="flex-1 text-xs md:text-sm leading-relaxed whitespace-pre-wrap">{design.seo.description}</span>
                                  <button onClick={() => handleCopy(design.seo!.description, 'Description')} className="p-1.5 hover:bg-zinc-800 rounded transition-colors mt-1 shrink-0">
                                    <Copy size={14} className="text-zinc-500" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {design.status === 'error' && (
                      <div className="glass-card p-6 border-red-500/20 bg-red-500/5 flex items-center gap-4">
                        <AlertCircle className="text-red-500 shrink-0" />
                        <div>
                          <p className="text-sm font-bold text-red-500">Error Processing Design</p>
                          <p className="text-xs text-red-400/70">{design.error}</p>
                        </div>
                        <button onClick={() => runAnalysis(design.id)} className="ml-auto px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold rounded-lg transition-colors">
                          Retry
                        </button>
                      </div>
                    )}

                    {index < designs.length - 1 && <div className="h-px bg-zinc-800 my-12" />}
                  </motion.div>
                ))}
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
